import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  readElementBorderBoxHeight,
  useOptionalContentRowWindowing,
} from './ContentRowWindowingContext';
import {
  composeFingerprint,
  composeIdentityFingerprint,
  createRowToken,
  createScopeToken,
  formatDebugKey,
} from './contentRowIdentity';
import { isContentRowWindowingEnabled } from './contentRowFeatureFlag';
import {
  ContentRowInteractionProvider,
  useContentRowInteractionPins,
} from './contentRowInteraction';
import type { ContentRowInteraction } from './contentRowInteraction';
import type {
  ContentRowKind,
  ContentRowPinReason,
  ContentRowPolicy,
  ContentRowWindowingRuntime,
} from './contentRowTypes';
import { cn } from '~/utils';

export type VirtualizedContentRowProps = {
  /** Message that owns this row. Used for lookup, never as identity. */
  messageId: string;
  kind: ContentRowKind;
  /**
   * Stable identity of the source inside the message: a split-block index, a content-part
   * index, or a tool call id. Must not change while the same rendered source is reused.
   */
  sourceKey: string | number;
  /** Diagnostics only. Distinguishes rows of the same kind within a message. */
  ordinal?: number;
  /** State that changes geometry without changing the source (expanded, revision, mode). */
  stateKey?: string | number | boolean | null;
  /** Optional hash of the content itself, for sources that can change in place. */
  contentKey?: string;
  /**
   * Required, and deliberately so. The Stage 3 policy is an allow-list, so a row that does not say
   * what it is may never window: an omitted or non-union value is treated at runtime as
   * `always-mounted` (report 13 §13.1, supervisor decision D1). Making it required is what stops a
   * future call site from silently opting into windowing by forgetting a prop.
   */
  policy: ContentRowPolicy | undefined;
  forceMounted?: boolean;
  /**
   * Hold this row mounted for a reason while set (§7.2). Pinning is the caller's decision —
   * focus, selection, an open portal — so it is expressed as a prop rather than internal
   * state.
   */
  pinReason?: ContentRowPinReason;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Notifies the owner of the generation currently mounted. The fixture uses it to register
   * readiness barriers for the right generation; production rows do not need it.
   */
  onGenerationChange?: (generation: number) => void;
  children: React.ReactNode;
};

/**
 * Content-row wrapper (spec 09 §7.4).
 *
 * With the feature flag off — or with no provider above it, which is how Stage 2 ships —
 * this renders a plain always-mounted block with no virtual-row attributes and performs no
 * registration, so the DOM is indistinguishable from the non-windowed tree.
 *
 * With windowing on, it renders a persistent shell plus a generation-specific inner element.
 * The shell is the intersection target and never a resize target; the inner element is the
 * only thing registered with the resize observer, so a placeholder can never report a
 * geometric measurement.
 */
export function VirtualizedContentRow(props: VirtualizedContentRowProps) {
  const windowing = useOptionalContentRowWindowing();
  if (!isContentRowWindowingEnabled() || !windowing) {
    return (
      <div className={props.className} style={props.style}>
        {props.children}
      </div>
    );
  }
  return <WindowedContentRow {...props} windowing={windowing} />;
}

/**
 * The policy actually registered. An omitted or unrecognized value falls back to `always-mounted`,
 * and a `unstable-until-settled` source becomes `windowed` only once its content reports ready —
 * and is kept mounted outright if it reports failure. Every other policy passes through unchanged,
 * so `always-mounted` content is never promoted by a readiness signal it should not have received.
 */
function resolveRowPolicy(
  policy: ContentRowPolicy | undefined,
  readinessStatus: 'pending' | 'ready' | 'failed',
): ContentRowPolicy {
  if (policy !== 'windowed' && policy !== 'unstable-until-settled') {
    return 'always-mounted';
  }
  if (policy === 'windowed') {
    return 'windowed';
  }
  if (readinessStatus === 'ready') {
    return 'windowed';
  }
  if (readinessStatus === 'failed') {
    return 'always-mounted';
  }
  return 'unstable-until-settled';
}

function WindowedContentRow({
  messageId,
  kind,
  sourceKey,
  ordinal = 0,
  stateKey,
  contentKey,
  policy,
  forceMounted = false,
  pinReason,
  className,
  style,
  onGenerationChange,
  children,
  windowing,
}: VirtualizedContentRowProps & { windowing: ContentRowWindowingRuntime }) {
  const token = useRef(createRowToken(`${messageId}:${kind}:${ordinal}`));
  const scopeToken = useRef(createScopeToken());
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{
    mounted: boolean;
    generation: number;
    height?: number;
  }>({ mounted: true, generation: 1 });

  const fingerprint = composeFingerprint({ kind, sourceKey, stateKey, contentKey });
  /**
   * The same composition without `stateKey`, handed to the provider so it can tell a new source
   * from the same source at a new size. Without it, expanding a row re-keys the subtree: the
   * transition's element is unmounted, the toggle loses keyboard focus, and the animation pin is
   * released before the transition can run.
   */
  const identityFingerprint = composeIdentityFingerprint({ kind, sourceKey, contentKey });
  const debugKey = formatDebugKey({ messageId, kind, ordinal });

  /**
   * Row-local interaction pins and the interaction API for this row's subtree (§6 Q5). This is
   * the only place in the row that adds DOM listeners, and every one of them is removed by the
   * same hook's cleanup.
   */
  const { interaction: pins, handlers } = useContentRowInteractionPins({
    windowing,
    token: token.current,
    shellRef,
  });

  /**
   * Asynchronous-content readiness (§8.2, §6 Q3), recorded against the generation whose subtree
   * reported it. A row whose content reports ready becomes windowable; one that reports failure
   * stays mounted. Storing the generation rather than a bare flag is what makes readiness reset by
   * itself on a remount, without an effect: the freshly mounted generation is `pending` until its
   * own content reports again — a cached image reports immediately, the current generation is
   * still measured from scratch.
   *
   * The reporters below close over the generation they were created for, and change identity with
   * it. That is load-bearing, not incidental. The provider that hands these to content sits
   * *outside* the element re-keyed on a generation change, so this component stays mounted and its
   * `setReadiness` stays live while the content mounted in the earlier generation does not. A
   * reporter captured before the change is therefore still callable afterwards; if it recorded
   * whichever generation happened to be live at call time, it would approve a generation whose
   * content has never reported, making the row windowable and letting the new content be replaced
   * by a placeholder before it loaded. Measured: with the row on generation 2 and its content
   * silent, a report from generation 1 turned it into a placeholder.
   */
  const generation = state.generation;
  const [readiness, setReadiness] = useState<{
    generation: number;
    status: 'ready' | 'failed';
  } | null>(null);
  const readinessStatus =
    readiness != null && readiness.generation === generation ? readiness.status : 'pending';

  const recordReadiness = useCallback(
    (status: 'ready' | 'failed') => {
      setReadiness((previous) => {
        // A report for a superseded generation is discarded rather than "corrected": the caller
        // observed content that is no longer mounted, so it says nothing about what is rendered
        // now. Keeping the newer record also stops a late report from clearing the current
        // generation's readiness, which would leave the row permanently unmeasured.
        if (previous != null && previous.generation > generation) {
          return previous;
        }
        return { generation, status };
      });
    },
    [generation],
  );
  const reportReady = useCallback(() => recordReadiness('ready'), [recordReadiness]);
  const reportFailed = useCallback(() => recordReadiness('failed'), [recordReadiness]);

  /**
   * The policy actually registered: an omitted or unrecognized value falls back to
   * `always-mounted`, and a `unstable-until-settled` source becomes `windowed` only once its
   * content reports ready (and is kept mounted outright if it reports failure). Every other policy
   * is passed through unchanged, so `always-mounted` content is never promoted by a readiness
   * signal it should not have received.
   */
  const resolvedPolicy = resolveRowPolicy(policy, readinessStatus);

  const interaction = useMemo<ContentRowInteraction>(
    () => ({ ...pins, reportReady, reportFailed }),
    [pins, reportFailed, reportReady],
  );

  /**
   * Registration uses the latest props without re-registering on every prop change; later
   * changes go through `updateRow`, which is what decides whether a measurement is still
   * valid.
   */
  const onGenerationChangeRef = useRef(onGenerationChange);
  onGenerationChangeRef.current = onGenerationChange;
  const latest = useRef({
    messageId,
    debugKey,
    kind,
    fingerprint,
    policy: resolvedPolicy,
    forceMounted,
  });
  latest.current = { messageId, debugKey, kind, fingerprint, policy: resolvedPolicy, forceMounted };

  useLayoutEffect(() => {
    const current = latest.current;
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId: current.messageId,
      debugKey: current.debugKey,
      kind: current.kind,
      fingerprint: current.fingerprint,
      policy: current.policy,
      forceMounted: current.forceMounted,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, generation: number, height?: number) => {
        setState({ mounted, generation, height });
        onGenerationChangeRef.current?.(generation);
      },
    });
  }, [windowing]);

  useEffect(() => {
    windowing.updateRow(token.current, {
      messageId,
      debugKey,
      fingerprint,
      identityFingerprint,
      policy: resolvedPolicy,
      forceMounted,
    });
  }, [
    windowing,
    messageId,
    debugKey,
    fingerprint,
    identityFingerprint,
    resolvedPolicy,
    forceMounted,
  ]);

  useEffect(() => {
    if (!pinReason) {
      return;
    }
    return windowing.pinRow(token.current, pinReason);
  }, [windowing, pinReason]);

  /**
   * The generation-specific measured element. A layout effect registers and synchronously
   * measures it, and the returned cleanup unobserves it — so a queued observer callback for
   * a superseded generation is rejected rather than applied to newer content.
   */
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const bucket = windowing.getLayoutBucket();
    const unregister = windowing.registerMountedContent({
      token: token.current,
      generation: state.generation,
      layoutBucket: bucket,
      element,
    });
    windowing.reportMountedContentHeight(
      token.current,
      state.generation,
      bucket,
      element,
      readElementBorderBoxHeight(element),
      'layout-effect',
    );
    return unregister;
  }, [windowing, state.generation, state.mounted]);

  return (
    <div
      ref={shellRef}
      onFocus={handlers.onFocus}
      onBlur={handlers.onBlur}
      onPointerDown={handlers.onPointerDown}
      className={cn('content-virtual-row', className)}
      style={state.mounted ? style : { ...style, height: `${state.height ?? 0}px` }}
      data-content-virtual-row="true"
      data-content-row-key={debugKey}
      data-content-row-kind={kind}
      data-content-mounted={state.mounted ? 'true' : 'false'}
      data-content-generation={state.generation}
      data-content-height-source={state.mounted ? 'measured-element' : 'placeholder'}
    >
      <ContentRowInteractionProvider value={interaction}>
        {state.mounted ? (
          <div key={state.generation} ref={contentRef} className="content-virtual-row__measured">
            {children}
          </div>
        ) : null}
      </ContentRowInteractionProvider>
    </div>
  );
}

export default VirtualizedContentRow;

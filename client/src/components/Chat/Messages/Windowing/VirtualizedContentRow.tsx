import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  readElementBorderBoxHeight,
  useOptionalContentRowWindowing,
} from './ContentRowWindowingContext';
import {
  composeFingerprint,
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
  policy?: ContentRowPolicy;
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

function WindowedContentRow({
  messageId,
  kind,
  sourceKey,
  ordinal = 0,
  stateKey,
  contentKey,
  policy = 'windowed',
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
   * Asynchronous-content readiness (§8.2, §6 Q3), recorded against the generation it was reported
   * for. A row whose content reports ready becomes windowable; one that reports failure stays
   * mounted. Storing the generation rather than a bare flag is what makes readiness reset by
   * itself on a remount, without an effect: the freshly mounted generation is `pending` until its
   * own content reports again — a cached image reports immediately, the current generation is
   * still measured from scratch.
   */
  const generationRef = useRef(state.generation);
  generationRef.current = state.generation;
  const [readiness, setReadiness] = useState<{
    generation: number;
    status: 'ready' | 'failed';
  } | null>(null);
  const readinessStatus =
    readiness != null && readiness.generation === state.generation ? readiness.status : 'pending';

  const reportReady = useCallback(() => {
    setReadiness({ generation: generationRef.current, status: 'ready' });
  }, []);
  const reportFailed = useCallback(() => {
    setReadiness({ generation: generationRef.current, status: 'failed' });
  }, []);

  /**
   * The policy actually registered: a `unstable-until-settled` source becomes `windowed` only once
   * its content reports ready, and is kept mounted outright if it reports failure. Every other
   * policy is passed through unchanged, so `always-mounted` content is never promoted by a
   * readiness signal it should not have received.
   */
  const resolvedPolicy: ContentRowPolicy =
    policy !== 'unstable-until-settled'
      ? policy
      : readinessStatus === 'ready'
        ? 'windowed'
        : readinessStatus === 'failed'
          ? 'always-mounted'
          : 'unstable-until-settled';

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
      policy: resolvedPolicy,
      forceMounted,
    });
  }, [windowing, messageId, debugKey, fingerprint, resolvedPolicy, forceMounted]);

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

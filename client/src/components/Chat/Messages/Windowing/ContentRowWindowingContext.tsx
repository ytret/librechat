/**
 * Content-row windowing provider.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md`
 *   §7.2 public interface      §7.3 registry record
 *   §7.5 mount state machine   §8.1 warm-up and settlement
 *   §10 mounting policy        §11 transitions
 *   §12 measurement validation §23 diagnostics
 *
 * Stage 2 task 2.2 delivers the provider shell and the registry. Rows register,
 * update, and unregister; every newly registered row starts mounted and nothing
 * ever unmounts yet (§8.1: "All newly registered rows start mounted. They do not
 * start as estimated placeholders."). Observers, settlement, geometry passes,
 * transactions, pins, and materialization arrive in tasks 2.3–2.8.
 *
 * Mount ownership: the provider is the single owner of mount/unmount decisions and
 * of scroll correction. Rows own their own React mount state and report it through
 * `setMounted`; they never decide to unmount themselves.
 *
 * Registry data lives in refs. No mounted-row state is published through React
 * context — that rule exists because a high-frequency context value would re-render
 * the whole message list on every mount decision.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
  createContentRowDiagnostics,
  createLiveDiagnosticsState,
  installContentRowDiagnostics,
} from './contentRowDiagnostics';
import { classifyMeasurement, computeLayoutBucket, nextGeneration } from './contentRowIdentity';
import type {
  ContentRowDiagnosticsSnapshot,
  ContentRowMeasurementSource,
  ContentRowRecord,
  ContentRowReflowState,
  ContentRowRegistration,
  ContentRowToken,
  ContentRowUpdate,
  ContentRowWindowingRuntime,
  LayoutBucket,
  MessageScopeToken,
  MountedContentRegistration,
} from './contentRowTypes';
import { CONTENT_ROW_QUIET_FRAMES, CONTENT_ROW_SETTLEMENT_TIMEOUT_MS } from './contentRowTypes';

/** Observer mapping for a mounted content element (§7.4). */
export type MountedElementMapping = {
  token: ContentRowToken;
  generation: number;
  layoutBucket: LayoutBucket;
};

/**
 * Bucket used before a scroll root can be measured (first render, detached tree).
 * Computed from the same function as real buckets so it can never collide with a
 * real bucket by accident.
 */
/** Clock used for settlement deadlines; injectable through `performance` in tests. */
function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export const UNKNOWN_LAYOUT_BUCKET: LayoutBucket = computeLayoutBucket({
  containerWidth: 0,
  fontSizePx: 16,
  renderingMode: 'markdown',
});

export const ContentRowWindowingContext = createContext<ContentRowWindowingRuntime | null>(null);

/**
 * Layout bucket for a scroll root (§12): container width bucket, font-size bucket,
 * and rendering mode. Null when there is no root to measure yet.
 */
export function readLayoutBucket(root: HTMLElement | null): LayoutBucket | null {
  if (!root) {
    return null;
  }
  const view = root.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? null : window);
  let fontSizePx = 16;
  if (view && typeof view.getComputedStyle === 'function') {
    const parsed = Number.parseFloat(view.getComputedStyle(root).fontSize);
    if (Number.isFinite(parsed) && parsed > 0) {
      fontSizePx = parsed;
    }
  }
  return computeLayoutBucket({
    containerWidth: root.clientWidth,
    fontSizePx,
    renderingMode: 'markdown',
  });
}

/** The `.message-render` shell that owns a row, which is what navigation resolves to. */
function messageShellOf(record: ContentRowRecord): HTMLElement | null {
  const shell =
    record.shellElement?.closest<HTMLElement>('.message-render') ??
    (typeof document === 'undefined' ? null : document.getElementById(record.messageId));
  return shell ?? null;
}

/**
 * Border-box height for the layout-effect path, which has no ResizeObserver entry.
 * The observer path prefers `borderBoxSize[0].blockSize` and only falls back to the
 * content rect (§12).
 */
export function readElementBorderBoxHeight(element: HTMLElement): number {
  return element.getBoundingClientRect().height;
}

/**
 * Whether a row is currently allowed to become a placeholder (§10 step 3, §20.2.9).
 *
 * Only a settled row in the `MOUNTED_MEASURED_SETTLED` state may unmount, which by
 * construction excludes unmeasured and unsettled rows. Everything else that disqualifies
 * a row is listed here so the rule is auditable in one place.
 */
export function canRowUnmount(record: ContentRowRecord): boolean {
  return (
    record.mounted &&
    record.settled &&
    record.mountState === 'MOUNTED_MEASURED_SETTLED' &&
    record.policy === 'windowed' &&
    record.pinnedByPolicy == null &&
    !record.forceMounted &&
    !record.oversized &&
    record.pins.size === 0 &&
    record.readinessPending === 0 &&
    record.measuredHeight != null &&
    record.measuredFingerprint === record.fingerprint
  );
}

export function ContentRowWindowingProvider({
  children,
  scrollRootRef,
  conversationId,
  isDevelopment = import.meta.env.DEV,
}: {
  children: React.ReactNode;
  scrollRootRef: React.RefObject<HTMLElement>;
  conversationId?: string | null;
  /**
   * Sticky "user is pinned to the bottom" signal owned by `useMessageScrolling`.
   * Part of the provider host contract; consumed by the anchor-correction rules in
   * task 2.6. Declared here so Stage 3 can wire it once and the signature never
   * changes. Not destructured until it is used, so no dead binding exists.
   */
  pinnedToBottomRef?: React.RefObject<boolean>;
  /** Injectable so tests and production agree on diagnostics installation. */
  isDevelopment?: boolean;
}) {
  const rows = useRef(new Map<ContentRowToken, ContentRowRecord>());
  const byMessageId = useRef(new Map<string, Set<ContentRowRecord>>());
  const mountedElements = useRef(new WeakMap<Element, MountedElementMapping>());
  const diagnostics = useRef(createContentRowDiagnostics());
  const layoutBucket = useRef<LayoutBucket | null>(null);
  const reflowState = useRef<ContentRowReflowState>('idle');
  const conversationRef = useRef<string | null>(conversationId ?? null);
  const resizeObserver = useRef<ResizeObserver | undefined>(undefined);
  const fontsReady = useRef(false);
  const warmUpComplete = useRef(false);
  /** token -> quiet frames still required before the row may settle (§8.1 step 4). */
  const pendingSettlements = useRef(new Map<ContentRowToken, number>());
  /** token -> absolute deadline for the per-row settlement timeout (§8.1). */
  const settlementDeadlines = useRef(new Map<ContentRowToken, number>());
  /**
   * Holder for the settlement loop's animation frame id. A wrapper object rather than a
   * number ref so the effect cleanup can capture it without reading `.current` after the
   * component may have unmounted.
   */
  const settlementLoop = useRef<{ frame?: number }>({});
  const scheduleSettlementLoop = useRef<() => void>(() => {});

  const currentBucket = useCallback((): LayoutBucket => {
    const bucket = readLayoutBucket(scrollRootRef.current);
    if (bucket != null) {
      layoutBucket.current = bucket;
      return bucket;
    }
    return layoutBucket.current ?? UNKNOWN_LAYOUT_BUCKET;
  }, [scrollRootRef]);

  const indexByMessage = useCallback((record: ContentRowRecord) => {
    let set = byMessageId.current.get(record.messageId);
    if (!set) {
      set = new Set();
      byMessageId.current.set(record.messageId, set);
    }
    set.add(record);
  }, []);

  const unindexByMessage = useCallback((record: ContentRowRecord) => {
    const set = byMessageId.current.get(record.messageId);
    if (!set) {
      return;
    }
    set.delete(record);
    if (set.size === 0) {
      byMessageId.current.delete(record.messageId);
    }
  }, []);

  /**
   * Note that a row has geometry to measure. Arms the per-row settlement timeout (§8.1)
   * and starts the quiet-frame loop. A row that keeps resizing keeps getting
   * measurements, but the deadline is *not* refreshed by them: the timeout exists to
   * stop unknown asynchronous geometry from ever becoming a placeholder.
   */
  const beginMeasurementWork = useCallback((record: ContentRowRecord) => {
    settlementDeadlines.current.set(
      record.token,
      performanceNow() + CONTENT_ROW_SETTLEMENT_TIMEOUT_MS,
    );
    scheduleSettlementLoop.current();
  }, []);

  /**
   * Complete warm-up once fonts are ready and no windowed row is still unsettled
   * (§8.1). A row that timed out is not "settled", but it can never become eligible to
   * unmount, so it must not hold warm-up open forever.
   */
  const maybeCompleteWarmUp = useCallback(() => {
    if (warmUpComplete.current || !fontsReady.current) {
      return;
    }
    let blocked = false;
    rows.current.forEach((record) => {
      if (record.policy !== 'windowed' || record.pinnedByPolicy != null) {
        return;
      }
      if (!record.settled) {
        blocked = true;
      }
    });
    if (blocked) {
      return;
    }
    warmUpComplete.current = true;
    diagnostics.current.completeWarmUp();
  }, []);

  /**
   * Mark a row settled for its current generation (§7.5). Only a mounted, measured,
   * readiness-clear row may settle; a stale generation is ignored rather than
   * corrupting a newer one.
   */
  const markRowSettled = useCallback(
    (token: ContentRowToken, generation: number) => {
      const record = rows.current.get(token);
      if (!record) {
        return;
      }
      if (record.generation !== generation || !record.mounted) {
        return;
      }
      if (record.measuredHeight == null || record.readinessPending > 0) {
        return;
      }
      record.settled = true;
      record.mountState = 'MOUNTED_MEASURED_SETTLED';
      pendingSettlements.current.delete(token);
      settlementDeadlines.current.delete(token);
      maybeCompleteWarmUp();
    },
    [maybeCompleteWarmUp],
  );

  /**
   * One provider-level frame pass for settlement (§8.1). No per-row timer or observer
   * exists; the provider owns the single loop.
   */
  const applySettlementPass = useCallback(() => {
    const now = performanceNow();

    // Settlement timeouts first. A row that exhausted its budget becomes effectively
    // always-mounted: unknown asynchronous geometry must never become a placeholder.
    Array.from(settlementDeadlines.current.entries()).forEach(([token, deadline]) => {
      const record = rows.current.get(token);
      if (!record) {
        settlementDeadlines.current.delete(token);
        return;
      }
      if (record.settled || now < deadline) {
        return;
      }
      const elapsedMs = Math.round(now - (deadline - CONTENT_ROW_SETTLEMENT_TIMEOUT_MS));
      record.policy = 'always-mounted';
      record.pinnedByPolicy = 'settlement-timeout';
      settlementDeadlines.current.delete(token);
      pendingSettlements.current.delete(token);
      diagnostics.current.recordSettleTimeout({
        debugKey: record.debugKey,
        kind: record.kind,
        elapsedMs,
      });
      if (record.readinessPending > 0) {
        diagnostics.current.recordReadinessTimeout({
          debugKey: record.debugKey,
          kind: record.kind,
          elapsedMs,
        });
      }
      maybeCompleteWarmUp();
    });

    if (fontsReady.current) {
      Array.from(pendingSettlements.current.entries()).forEach(([token, remaining]) => {
        const record = rows.current.get(token);
        if (!record) {
          pendingSettlements.current.delete(token);
          return;
        }
        if (!record.mounted || record.measuredHeight == null) {
          pendingSettlements.current.delete(token);
          return;
        }
        if (record.readinessPending > 0) {
          pendingSettlements.current.set(token, CONTENT_ROW_QUIET_FRAMES);
          return;
        }
        if (remaining > 1) {
          pendingSettlements.current.set(token, remaining - 1);
          return;
        }
        markRowSettled(token, record.generation);
      });
    }
  }, [markRowSettled, maybeCompleteWarmUp]);

  scheduleSettlementLoop.current = () => {
    const loop = settlementLoop.current;
    if (loop.frame != null) {
      return;
    }
    loop.frame = requestAnimationFrame(() => {
      loop.frame = undefined;
      applySettlementPass();
      if (pendingSettlements.current.size > 0 || settlementDeadlines.current.size > 0) {
        scheduleSettlementLoop.current();
      }
    });
  };

  /** Release a row's measurement waiters so navigation can proceed (§20.7.2). */
  const releaseMeasurementWaiters = useCallback((record: ContentRowRecord) => {
    if (record.measurementWaiters.size === 0) {
      return;
    }
    record.measurementWaiters.forEach((resolve) => resolve());
    record.measurementWaiters.clear();
  }, []);

  /**
   * Register an asynchronous renderer's readiness (§8.2). The row cannot settle, and
   * therefore cannot unmount, until every registered promise has settled. Returns an
   * unsubscribe function; unsubscribing releases the barrier rather than leaving the row
   * unsettled forever.
   */
  const registerReadiness = useCallback(
    (token: ContentRowToken, generation: number, readiness: Promise<unknown>) => {
      const record = rows.current.get(token);
      if (!record || record.generation !== generation) {
        return () => {};
      }
      record.readinessPending += 1;
      record.settled = false;
      if (record.mountState === 'MOUNTED_MEASURED_SETTLED') {
        record.mountState = 'MOUNTED_MEASURED_UNSETTLED';
      }
      pendingSettlements.current.set(token, CONTENT_ROW_QUIET_FRAMES);
      scheduleSettlementLoop.current();
      let released = false;
      const release = () => {
        if (released) {
          return;
        }
        released = true;
        record.readinessPending = Math.max(0, record.readinessPending - 1);
        pendingSettlements.current.set(token, CONTENT_ROW_QUIET_FRAMES);
        scheduleSettlementLoop.current();
      };
      readiness.then(release, release);
      return release;
    },
    [],
  );

  /**
   * Drop the measurement in hand without touching mount state. §13's opening rule:
   * an invalid measurement must never survive as a placeholder height, and §12
   * rule 6 rejects any in-flight measurement captured under the old fingerprint.
   */
  const invalidateMeasurement = useCallback(
    (record: ContentRowRecord) => {
      record.measuredElement = null;
      record.measuredHeight = undefined;
      record.measuredFingerprint = undefined;
      record.settled = false;
      record.mountState = 'MOUNTED_UNMEASURED';
      pendingSettlements.current.delete(record.token);
      beginMeasurementWork(record);
    },
    [beginMeasurementWork],
  );

  /**
   * Start a new generation for a row whose source changed (§7.5). The measured
   * element is re-keyed, so the row re-measures from scratch instead of reusing a
   * height that described the previous source.
   */
  const startGeneration = useCallback(
    (record: ContentRowRecord, fingerprint: string) => {
      record.generation = nextGeneration(record.generation);
      record.fingerprint = fingerprint;
      record.measuredFingerprint = fingerprint;
      record.measuredElement = null;
      record.measuredHeight = undefined;
      record.settled = false;
      record.mounted = true;
      record.mountState = 'MOUNTED_UNMEASURED';
      pendingSettlements.current.delete(record.token);
      beginMeasurementWork(record);
      record.setMounted(true, record.generation);
    },
    [beginMeasurementWork],
  );

  const unregisterRow = useCallback(
    (record: ContentRowRecord) => {
      rows.current.delete(record.token);
      unindexByMessage(record);
      if (record.shellElement) {
        mountedElements.current.delete(record.shellElement);
      }
      // Any waiter must be released; nothing may hang on a row that no longer exists.
      record.commitWaiters.forEach((resolve) => resolve());
      record.commitWaiters.clear();
      record.measurementWaiters.forEach((resolve) => resolve());
      record.measurementWaiters.clear();
      record.readinessPending = 0;
      if (record.measuredElement) {
        resizeObserver.current?.unobserve(record.measuredElement);
        mountedElements.current.delete(record.measuredElement);
        record.measuredElement = null;
      }
      diagnostics.current.recordUnregistration();
    },
    [unindexByMessage],
  );

  const registerRow = useCallback(
    (registration: ContentRowRegistration) => {
      if (rows.current.has(registration.token)) {
        return () => {};
      }
      const record: ContentRowRecord = {
        token: registration.token,
        scopeToken: registration.scopeToken,
        messageId: registration.messageId,
        conversationId: conversationRef.current,
        debugKey: registration.debugKey,
        kind: registration.kind,
        fingerprint: registration.fingerprint,
        measuredFingerprint: registration.fingerprint,
        policy: registration.policy,
        shellElement: registration.shellElement,
        measuredElement: null,
        // §8.1 — never an estimated placeholder on first registration.
        mounted: true,
        committedMounted: true,
        generation: 1,
        layoutBucket: currentBucket(),
        measuredHeight: undefined,
        mountState: 'MOUNTED_UNMEASURED',
        settled: false,
        forceMounted: registration.forceMounted,
        oversized: false,
        pinnedByPolicy: null,
        pins: new Set(),
        readinessPending: 0,
        measurementWaiters: new Set(),
        setMounted: registration.setMounted,
        commitWaiters: new Set(),
      };
      rows.current.set(record.token, record);
      indexByMessage(record);
      diagnostics.current.recordRegistration();
      // §8.1 — every newly registered row starts mounted and begins its measurement and
      // settlement budget immediately, never as an estimated placeholder.
      beginMeasurementWork(record);
      return () => {
        pendingSettlements.current.delete(record.token);
        settlementDeadlines.current.delete(record.token);
        unregisterRow(record);
        maybeCompleteWarmUp();
      };
    },
    [beginMeasurementWork, currentBucket, indexByMessage, maybeCompleteWarmUp, unregisterRow],
  );

  const updateRow = useCallback(
    (token: ContentRowToken, update: ContentRowUpdate) => {
      const record = rows.current.get(token);
      if (!record) {
        return;
      }
      if (update.messageId !== undefined && update.messageId !== record.messageId) {
        unindexByMessage(record);
        record.messageId = update.messageId;
        indexByMessage(record);
      }
      if (update.debugKey !== undefined) {
        record.debugKey = update.debugKey;
      }
      if (update.policy !== undefined) {
        record.policy = update.policy;
      }
      if (update.forceMounted !== undefined) {
        record.forceMounted = update.forceMounted;
      }
      if (update.fingerprint !== undefined && update.fingerprint !== record.fingerprint) {
        startGeneration(record, update.fingerprint);
      }
    },
    [indexByMessage, startGeneration, unindexByMessage],
  );

  const getLayoutBucket = useCallback(() => currentBucket(), [currentBucket]);

  /**
   * Accept a measured height for a row's current generation (§12).
   *
   * The seven acceptance rules live in `classifyMeasurement` and are applied here in
   * full. A rejected observation is a strict no-op: it cannot overwrite a height, mark
   * the row measured or settled, release a waiter, change bottom pinning, or write
   * scroll position.
   */
  const reportMountedContentHeight = useCallback(
    (
      token: ContentRowToken,
      generation: number,
      layoutBucketOfReport: LayoutBucket,
      element: HTMLElement,
      height: number,
      source: ContentRowMeasurementSource,
    ) => {
      const record = rows.current.get(token);
      const verdict = classifyMeasurement(record, {
        element,
        generation,
        layoutBucket: layoutBucketOfReport,
        height,
      });
      if (!verdict.accepted) {
        diagnostics.current.recordRejectedMeasurement(verdict.reason);
        return;
      }
      if (record == null) {
        return;
      }
      // Tripwire: an accepted observation must still satisfy the invariants the
      // acceptance test relies on. If this ever fires, the acceptance test and this
      // check disagreed, and accepting the measurement was wrong.
      if (
        !record.mounted ||
        record.measuredElement !== element ||
        record.generation !== generation ||
        record.measuredFingerprint !== record.fingerprint
      ) {
        diagnostics.current.recordStaleMeasurementAccepted();
      }
      // §12: the browser value is retained for placeholders; rounding is diagnostics only.
      record.measuredHeight = height;
      record.settled = false;
      record.mountState = 'MOUNTED_MEASURED_UNSETTLED';
      diagnostics.current.recordAcceptedMeasurement(source);
      // §8.1 step 4 — the row settles after this measurement plus two quiet frames; any
      // further resize restarts the count, so "quiet" means "no resize in between".
      pendingSettlements.current.set(record.token, CONTENT_ROW_QUIET_FRAMES);
      scheduleSettlementLoop.current();
      releaseMeasurementWaiters(record);
    },
    [releaseMeasurementWaiters],
  );

  /**
   * Bind a row's generation-specific measured element (the inner element, never the
   * persistent shell) to the shared resize observer. The observer is the only resize
   * target, so a placeholder shell can never report a geometric measurement (§20.2.3).
   */
  const registerMountedContent = useCallback(
    (registration: MountedContentRegistration) => {
      const record = rows.current.get(registration.token);
      if (!record || record.generation !== registration.generation) {
        // A registration from a superseded generation must not become the target.
        return () => {};
      }
      const previous = record.measuredElement;
      if (previous && previous !== registration.element) {
        resizeObserver.current?.unobserve(previous);
        mountedElements.current.delete(previous);
      }
      const bucketChanged = record.layoutBucket !== registration.layoutBucket;
      if (bucketChanged) {
        // §13 — a bucket change invalidates the measurement. The fingerprint capture
        // stays valid, so the next measurement in the new bucket is accepted.
        record.layoutBucket = registration.layoutBucket;
      }
      const elementChanged = previous !== registration.element;
      if (elementChanged || bucketChanged) {
        record.measuredHeight = undefined;
        record.settled = false;
        record.mountState = 'MOUNTED_UNMEASURED';
        pendingSettlements.current.delete(record.token);
        beginMeasurementWork(record);
      }
      record.measuredElement = registration.element;
      mountedElements.current.set(registration.element, {
        token: registration.token,
        generation: registration.generation,
        layoutBucket: registration.layoutBucket,
      });
      resizeObserver.current?.observe(registration.element);
      return () => {
        const mapping = mountedElements.current.get(registration.element);
        if (mapping && mapping.generation === registration.generation) {
          mountedElements.current.delete(registration.element);
          resizeObserver.current?.unobserve(registration.element);
        }
        if (record.measuredElement === registration.element) {
          record.measuredElement = null;
        }
      };
    },
    [beginMeasurementWork],
  );

  /**
   * Resolve the message shell that owns a message's rows, mounting them on the way.
   *
   * Task 2.8 adds the current-generation measurement wait required by §20.7.2 and
   * the navigation timeout; here it mounts the rows and returns the shell.
   */
  const ensureMessageContentMounted = useCallback(async (messageId: string) => {
    const records = byMessageId.current.get(messageId);
    if (!records || records.size === 0) {
      return null;
    }
    let shell: HTMLElement | null = null;
    for (const record of records) {
      if (!record.mounted) {
        record.mounted = true;
        record.setMounted(true, record.generation);
      }
      shell = shell ?? messageShellOf(record);
    }
    return shell;
  }, []);

  const getDiagnostics = useCallback((): ContentRowDiagnosticsSnapshot => {
    return diagnostics.current.snapshot(
      createLiveDiagnosticsState(rows.current.values(), {
        layoutBucket: layoutBucket.current,
        reflowState: reflowState.current,
      }),
    );
  }, []);

  const value = useMemo(
    () => ({
      registerRow,
      updateRow,
      registerMountedContent,
      reportMountedContentHeight,
      markRowSettled,
      registerReadiness,
      getLayoutBucket,
      ensureMessageContentMounted,
      getDiagnostics,
    }),
    [
      registerRow,
      updateRow,
      registerMountedContent,
      reportMountedContentHeight,
      markRowSettled,
      registerReadiness,
      getLayoutBucket,
      ensureMessageContentMounted,
      getDiagnostics,
    ],
  );

  /**
   * One provider-level resize observer for mounted inner content elements only.
   *
   * Rows register their element from a layout effect, which runs before this effect on
   * first mount, so elements registered earlier are attached here as well. A queued
   * callback for an element whose generation has been superseded is rejected because
   * the mapping is looked up by element and validated against the record (§7.4).
   */
  useEffect(() => {
    // Captured so teardown never reads a ref after unmount.
    const loop = settlementLoop.current;
    const pending = pendingSettlements.current;
    const deadlines = settlementDeadlines.current;
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (loop.frame != null) {
          cancelAnimationFrame(loop.frame);
          loop.frame = undefined;
        }
        pending.clear();
        deadlines.clear();
      };
    }
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const mapping = mountedElements.current.get(entry.target);
        if (!mapping) {
          diagnostics.current.recordRejectedMeasurement('unknown-element');
          return;
        }
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        reportMountedContentHeight(
          mapping.token,
          mapping.generation,
          mapping.layoutBucket,
          entry.target as HTMLElement,
          height,
          'resize-observer',
        );
      });
    });
    resizeObserver.current = observer;
    rows.current.forEach((record) => {
      if (record.mounted && record.measuredElement) {
        observer.observe(record.measuredElement);
      }
    });
    return () => {
      observer.disconnect();
      resizeObserver.current = undefined;
      if (loop.frame != null) {
        cancelAnimationFrame(loop.frame);
        loop.frame = undefined;
      }
      pending.clear();
      deadlines.clear();
    };
  }, [reportMountedContentHeight]);

  /**
   * §8.1 step 3 — the provider waits for `document.fonts.ready` before any row may
   * settle. Fonts are a document-level fact, so this is established once; environments
   * without the Font Loading API are treated as already ready.
   */
  useEffect(() => {
    const fonts = (typeof document === 'undefined' ? undefined : document.fonts) as
      | FontFaceSet
      | undefined;
    const ready = fonts?.ready;
    if (!ready || typeof ready.then !== 'function') {
      fontsReady.current = true;
      scheduleSettlementLoop.current();
      maybeCompleteWarmUp();
      return;
    }
    let cancelled = false;
    const markReady = () => {
      if (cancelled) {
        return;
      }
      fontsReady.current = true;
      scheduleSettlementLoop.current();
      maybeCompleteWarmUp();
    };
    ready.then(markReady, markReady);
    return () => {
      cancelled = true;
    };
  }, [maybeCompleteWarmUp]);

  // Development-only console handle (§23). Production installs nothing.
  useEffect(() => {
    return installContentRowDiagnostics(diagnostics.current, {
      isDevelopment,
      getLive: () =>
        createLiveDiagnosticsState(rows.current.values(), {
          layoutBucket: layoutBucket.current,
          reflowState: reflowState.current,
        }),
    });
  }, [isDevelopment]);

  /**
   * A conversation change must not let a reused component position keep a height
   * measured for another conversation. Rows are invalidated, never unmounted, and
   * the comparison is per record so it cannot race with rows registering for the
   * new conversation in the same commit.
   */
  useEffect(() => {
    conversationRef.current = conversationId ?? null;
    // A new conversation starts a fresh warm-up phase (§8.1).
    warmUpComplete.current = false;
    diagnostics.current.startWarmUp();
    rows.current.forEach((record) => {
      if (record.conversationId === conversationRef.current) {
        return;
      }
      record.conversationId = conversationRef.current;
      invalidateMeasurement(record);
    });
  }, [conversationId, invalidateMeasurement]);

  return (
    <ContentRowWindowingContext.Provider value={value}>
      {children}
    </ContentRowWindowingContext.Provider>
  );
}

export function useContentRowWindowing(): ContentRowWindowingRuntime {
  const context = useContext(ContentRowWindowingContext);
  if (!context) {
    throw new Error('useContentRowWindowing must be used within ContentRowWindowingProvider');
  }
  return context;
}

export function useOptionalContentRowWindowing(): ContentRowWindowingRuntime | null {
  return useContext(ContentRowWindowingContext);
}

export type { MessageScopeToken };

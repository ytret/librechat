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
import { flushSync } from 'react-dom';
import {
  createContentRowDiagnostics,
  createLiveDiagnosticsState,
  installContentRowDiagnostics,
} from './contentRowDiagnostics';
import { classifyMeasurement, computeLayoutBucket, nextGeneration } from './contentRowIdentity';
import type {
  ContentRowDiagnosticsSnapshot,
  ContentRowMaterializeReason,
  ContentRowMeasurementSource,
  ContentRowPassScheduleReason,
  ContentRowPinReason,
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
import {
  MATERIALIZE_SETTLE_TIMEOUT_MS,
  MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX,
  MIN_ANCHOR_CORRECTION_PX,
  NAVIGATION_MEASUREMENT_TIMEOUT_MS,
  CONTENT_ROW_OVERSCAN_PX,
  CONTENT_ROW_QUIET_FRAMES,
  CONTENT_ROW_SETTLEMENT_TIMEOUT_MS,
  CONTENT_ROW_UNMOUNT_HYSTERESIS_PX,
  MAX_MOUNTS_PER_FRAME,
  MAX_UNMOUNTS_PER_FRAME,
} from './contentRowTypes';

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
  pinnedToBottomRef,
  isDevelopment = import.meta.env.DEV,
}: {
  children: React.ReactNode;
  scrollRootRef: React.RefObject<HTMLElement>;
  conversationId?: string | null;
  /** Sticky "user is pinned to the bottom" signal owned by `useMessageScrolling`. */
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
  const intersectionObserver = useRef<IntersectionObserver | undefined>(undefined);
  const geometryLoop = useRef<{ frame?: number }>({});
  const geometryPassId = useRef(0);
  /** Bumped on every conversation change so queued decisions cannot outlive it. */
  const conversationEpoch = useRef(0);
  /** Bumped when the scroll direction changes; queued priority decisions are stale then. */
  const directionEpoch = useRef(0);
  const lastScrollTop = useRef<number | null>(null);
  const lastScrollDirection = useRef(0);
  const scheduleGeometryPass = useRef<(reason?: ContentRowPassScheduleReason) => void>(() => {});
  /** Frame-coalesced accumulator for asynchronous (resize-driven) corrections (§11.3). */
  const asyncCorrection = useRef<{ frame?: number; pending: number }>({ pending: 0 });
  const transitionBatchId = useRef(0);
  /** Non-'none' while a materialization operation owns the DOM (§10 step 7). */
  const materializationMode = useRef<'none' | ContentRowMaterializeReason>('none');
  const pinnedToBottomFallbackRef = useRef(false);
  const pinnedToBottom = pinnedToBottomRef ?? pinnedToBottomFallbackRef;

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
    // §8.1 step 6 — after warm-up the provider evaluates distance and unmounts eligible
    // distant rows. Without this pass nothing would unmount until the reader scrolled, since
    // the only other triggers are scroll and intersection events.
    scheduleGeometryPass.current('warm-up');
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
      // Settling is what makes a row eligible to unmount, so the window must be re-evaluated.
      // The pass is frame-debounced, so a burst of settlements produces one pass.
      scheduleGeometryPass.current('settled');
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
      diagnostics.current.recordSettlementPass(
        pendingSettlements.current.size,
        settlementDeadlines.current.size,
      );
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

  /** A row that must always be mounted regardless of distance. */
  const mustBeMounted = (record: ContentRowRecord): boolean =>
    record.forceMounted ||
    record.pins.size > 0 ||
    record.pinnedByPolicy != null ||
    record.policy !== 'windowed';

  /**
   * Remount a placeholder (§8.3). The generation is incremented so the row renders a new
   * generation-specific measured element; the row keeps its fixed cached shell height
   * during the update and removes it in the same commit that real content lands.
   */
  const mountRow = useCallback(
    (record: ContentRowRecord): boolean => {
      if (record.mounted) {
        return false;
      }
      record.generation = nextGeneration(record.generation);
      record.mounted = true;
      record.committedMounted = true;
      record.measuredFingerprint = record.fingerprint;
      record.measuredElement = null;
      record.settled = false;
      record.mountState = 'MOUNTED_UNMEASURED';
      pendingSettlements.current.delete(record.token);
      beginMeasurementWork(record);
      record.setMounted(true, record.generation);
      return true;
    },
    [beginMeasurementWork],
  );

  /**
   * Turn a settled row into an exact-height placeholder. The height handed to the row is
   * the last accepted border-box height for the current bucket — never an estimate, never
   * a capped value (§6 #4, §24).
   */
  const unmountRow = useCallback((record: ContentRowRecord): boolean => {
    if (!record.mounted || !canRowUnmount(record)) {
      return false;
    }
    const height = record.measuredHeight;
    record.mounted = false;
    record.committedMounted = false;
    record.mountState = 'PLACEHOLDER_MEASURED';
    record.setMounted(false, record.generation, height);
    return true;
  }, []);

  /**
   * A later asynchronous resize is not a mount transaction (§11.3). If the changed row is
   * wholly above the viewport and the reader is not bottom-pinned or elastically
   * overscrolled, the offset error introduced by the change is corrected once per frame.
   *
   * The correction is the height delta of the changed row, which is exactly the amount
   * everything below it moved by. A delta above
   * `MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX` is a development failure: the row is demoted
   * to always-mounted so the same geometry is never turned into a placeholder again.
   */
  const scheduleAsyncCorrection = useCallback(
    (record: ContentRowRecord, delta: number) => {
      if (Math.abs(delta) < MIN_ANCHOR_CORRECTION_PX) {
        return;
      }
      const root = scrollRootRef.current;
      if (!root || pinnedToBottom.current) {
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const shellRect = record.shellElement?.getBoundingClientRect();
      if (!shellRect || shellRect.bottom > rootRect.top) {
        // Only content wholly above the viewport can displace what the reader is looking at.
        return;
      }
      asyncCorrection.current.pending += delta;
      if (asyncCorrection.current.frame != null) {
        return;
      }
      asyncCorrection.current.frame = requestAnimationFrame(() => {
        asyncCorrection.current.frame = undefined;
        const target = scrollRootRef.current;
        const amount = asyncCorrection.current.pending;
        asyncCorrection.current.pending = 0;
        if (!target || Math.abs(amount) < MIN_ANCHOR_CORRECTION_PX) {
          return;
        }
        const max = target.scrollHeight - target.clientHeight;
        if (target.scrollTop < 0 || target.scrollTop > max) {
          // §11.4 — never fight an elastic overscroll.
          return;
        }
        target.scrollTop += amount;
        diagnostics.current.recordScrollWrite();
        diagnostics.current.recordAsyncCorrection(amount);
        if (Math.abs(amount) > MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX) {
          diagnostics.current.recordOverBudgetCorrection();
          record.policy = 'always-mounted';
          record.pinnedByPolicy = 'async-correction';
        }
      });
    },
    [pinnedToBottom, scrollRootRef],
  );

  /**
   * Apply one mount/unmount batch as a single transition (§11.1).
   *
   * Every geometry read happens before any write, all row state setters run inside one
   * `flushSync` so the generation-specific layout effects register and measure before the
   * flush returns, and the anchor is re-read afterwards to compute at most one correction
   * write.
   */
  const applyTransitionBatch = useCallback(
    (batch: {
      mounts: ContentRowRecord[];
      unmounts: ContentRowRecord[];
      /** Rectangles read during classification, keyed by token. */
      rects: Map<ContentRowToken, { top: number; bottom: number }>;
    }) => {
      if (batch.mounts.length === 0 && batch.unmounts.length === 0) {
        // Nothing eligible this pass: no flushSync, no geometry reads, no write.
        return { mounts: 0, unmounts: 0, displacement: 0, correction: 0 };
      }
      const root = scrollRootRef.current;
      const rootRect = root?.getBoundingClientRect();
      const transitionTokens = new Set(
        [...batch.mounts, ...batch.unmounts].map((record) => record.token),
      );

      // 1-2. Choose an anchor outside the transition set, using rectangles already read.
      let anchorElement: HTMLElement | null = null;
      let anchorTopBefore: number | null = null;
      if (root && rootRect) {
        for (const record of rows.current.values()) {
          if (transitionTokens.has(record.token)) {
            continue;
          }
          const element = record.shellElement;
          if (!element?.isConnected) {
            continue;
          }
          const rect = batch.rects.get(record.token) ?? element.getBoundingClientRect();
          if (rect.bottom > rootRect.top && rect.top < rootRect.bottom) {
            anchorElement = element;
            anchorTopBefore = rect.top;
            break;
          }
        }
        if (!anchorElement) {
          // Fall back to the containing message shell of any connected row.
          const fallback = [...rows.current.values()]
            .map((record) => record.shellElement?.closest<HTMLElement>('.message-render') ?? null)
            .find((element) => element?.isConnected);
          anchorElement = fallback ?? null;
          anchorTopBefore = anchorElement?.getBoundingClientRect().top ?? null;
        }
      }

      const pinned = pinnedToBottom.current;
      const scrollBefore = root ? root.scrollTop : null;
      const startedAt = performanceNow();
      let mounts = 0;
      let unmounts = 0;

      // 3-4. One flushSync for the whole batch; layout effects measure inside it.
      flushSync(() => {
        batch.mounts.forEach((record) => {
          if (mountRow(record)) {
            mounts += 1;
          }
        });
        batch.unmounts.forEach((record) => {
          if (unmountRow(record)) {
            unmounts += 1;
          }
        });
      });
      const durationMs = performanceNow() - startedAt;

      if (mounts === 0 && unmounts === 0) {
        return { mounts, unmounts, displacement: 0, correction: 0 };
      }

      // 5-8. Re-read the same anchor and perform at most one correction write.
      let displacement = 0;
      let correction = 0;
      if (root && scrollBefore != null) {
        const max = root.scrollHeight - root.clientHeight;
        const elastic = scrollBefore < 0 || scrollBefore > max;
        // A batch is abandoned without correction when its anchor disconnected.
        if (!elastic && (!anchorElement || anchorElement.isConnected)) {
          if (pinned) {
            // Bottom-pinned: preserve the bottom, never also run top-anchor correction.
            const target = Math.max(0, max);
            if (Math.abs(target - scrollBefore) >= MIN_ANCHOR_CORRECTION_PX) {
              root.scrollTop = target;
              diagnostics.current.recordScrollWrite();
            }
          } else if (anchorElement && anchorTopBefore != null) {
            displacement = anchorElement.getBoundingClientRect().top - anchorTopBefore;
            if (Math.abs(displacement) >= MIN_ANCHOR_CORRECTION_PX) {
              root.scrollTop += displacement;
              diagnostics.current.recordScrollWrite();
            }
          }
        }
        correction = root.scrollTop - scrollBefore;
      }

      if (Math.abs(correction) > MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX) {
        diagnostics.current.recordOverBudgetCorrection();
      }

      diagnostics.current.recordMountBatch({
        id: (transitionBatchId.current += 1),
        mounts,
        unmounts,
        durationMs,
        anchorDisplacement: displacement,
        anchorCorrection: correction,
      });
      return { mounts, unmounts, displacement, correction };
    },
    [mountRow, pinnedToBottom, scrollRootRef, unmountRow],
  );

  /**
   * One geometry pass (§10). Reads every rectangle before writing any mount state, so a
   * write cannot invalidate a later measurement in the same pass.
   */
  const runGeometryPass = useCallback(
    (pass: {
      id: number;
      conversationEpoch: number;
      directionEpoch: number;
      layoutBucket: LayoutBucket;
    }) => {
      const root = scrollRootRef.current;
      if (!root) {
        diagnostics.current.recordPassDiscarded('no-root');
        return;
      }
      // §10 step 7 — discard queued decisions when the conversation, layout bucket, or
      // travel direction changed after this pass was scheduled, then schedule a fresh
      // pass so the change is not lost.
      if (materializationMode.current !== 'none') {
        // §10 step 7 — a materialization owns mount state; a geometry pass would fight it.
        diagnostics.current.recordPassDiscarded('materializing');
        return;
      }
      if (pass.conversationEpoch !== conversationEpoch.current) {
        diagnostics.current.recordPassDiscarded('conversation-changed');
        scheduleGeometryPass.current('discard');
        return;
      }
      if (pass.directionEpoch !== directionEpoch.current) {
        diagnostics.current.recordPassDiscarded('direction-changed');
        scheduleGeometryPass.current('discard');
        return;
      }
      const bucket = currentBucket();
      if (pass.layoutBucket !== bucket) {
        diagnostics.current.recordPassDiscarded('bucket-changed');
        scheduleGeometryPass.current('discard');
        return;
      }
      diagnostics.current.recordPassApplied();

      const rootRect = root.getBoundingClientRect();
      const direction = lastScrollDirection.current;

      type Candidate = {
        record: ContentRowRecord;
        inViewport: boolean;
        aheadInTravel: boolean;
        distance: number;
      };

      const mountCandidates: Candidate[] = [];
      const unmountCandidates: Array<{ record: ContentRowRecord; distance: number }> = [];
      /** Every rectangle read in this pass, reused for anchor selection (§11.1 step 2). */
      const rects = new Map<ContentRowToken, { top: number; bottom: number }>();

      // Batch-read every candidate rectangle before any write.
      rows.current.forEach((record) => {
        const element = record.shellElement;
        if (!element) {
          return;
        }
        const rect = element.getBoundingClientRect();
        rects.set(record.token, { top: rect.top, bottom: rect.bottom });
        const inViewport = rect.bottom > rootRect.top && rect.top < rootRect.bottom;
        const near =
          rect.bottom >= rootRect.top - CONTENT_ROW_OVERSCAN_PX &&
          rect.top <= rootRect.bottom + CONTENT_ROW_OVERSCAN_PX;
        const far =
          rect.bottom < rootRect.top - CONTENT_ROW_UNMOUNT_HYSTERESIS_PX ||
          rect.top > rootRect.bottom + CONTENT_ROW_UNMOUNT_HYSTERESIS_PX;

        if (!record.mounted && (near || mustBeMounted(record))) {
          let aheadInTravel = true;
          if (direction > 0) {
            aheadInTravel = rect.top >= rootRect.top;
          } else if (direction < 0) {
            aheadInTravel = rect.bottom <= rootRect.bottom;
          }
          const distance =
            direction < 0
              ? Math.max(0, rootRect.top - rect.bottom)
              : Math.max(0, rect.top - rootRect.bottom);
          mountCandidates.push({ record, inViewport, aheadInTravel, distance });
          return;
        }

        // §10 step 3 — everything ineligible was discarded by canRowUnmount, which also
        // enforces the hysteresis: a far row that is only just outside the unmount band is
        // retained, so mount/unmount cannot flap at the boundary.
        if (far && canRowUnmount(record)) {
          unmountCandidates.push({
            record,
            distance: Math.max(rect.bottom - rootRect.bottom, rootRect.top - rect.top),
          });
        }
      });

      // §10 step 4 — visible rows first, then rows ahead in the travel direction, then by
      // distance. Rows inside the viewport bypass the ordinary mount budget and are counted.
      mountCandidates.sort((a, b) => {
        if (a.inViewport !== b.inViewport) {
          return a.inViewport ? -1 : 1;
        }
        if (a.aheadInTravel !== b.aheadInTravel) {
          return a.aheadInTravel ? -1 : 1;
        }
        return a.distance - b.distance;
      });

      const viewportMounts = mountCandidates.filter((candidate) => candidate.inViewport);
      const budgetedMounts = mountCandidates
        .filter((candidate) => !candidate.inViewport)
        .slice(0, MAX_MOUNTS_PER_FRAME);
      if (viewportMounts.length > 0) {
        diagnostics.current.recordViewportBypass(viewportMounts.length);
      }

      // §10 step 6 — unmount candidates are collected first but applied in a separate,
      // later phase of the same batch: all mount work happens before any unmount work.
      unmountCandidates.sort((a, b) => b.distance - a.distance);

      const { mounts, unmounts } = applyTransitionBatch({
        mounts: [...viewportMounts, ...budgetedMounts].map((candidate) => candidate.record),
        unmounts: unmountCandidates
          .slice(0, MAX_UNMOUNTS_PER_FRAME)
          .map((candidate) => candidate.record),
        rects,
      });

      // §11.1 step 9 — work that exceeded a budget is continued in a later frame. Only
      // reschedule when this pass made progress, so a candidate that cannot be applied can
      // never spin the loop.
      const deferredWork =
        mountCandidates.length - (viewportMounts.length + budgetedMounts.length) > 0 ||
        unmountCandidates.length - unmounts > 0;
      if (deferredWork && (mounts > 0 || unmounts > 0)) {
        scheduleGeometryPass.current('deferred');
      }
    },
    [applyTransitionBatch, currentBucket, scrollRootRef],
  );

  scheduleGeometryPass.current = (reason: ContentRowPassScheduleReason = 'discard') => {
    // The reason is recorded even when a pass is already queued for this frame, so the
    // attribution below accounts for every trigger and a repeated trigger is visible.
    diagnostics.current.recordPassScheduled(reason);
    const loop = geometryLoop.current;
    if (loop.frame != null) {
      return;
    }
    const pass = {
      id: (geometryPassId.current += 1),
      conversationEpoch: conversationEpoch.current,
      directionEpoch: directionEpoch.current,
      layoutBucket: currentBucket(),
    };
    loop.frame = requestAnimationFrame(() => {
      loop.frame = undefined;
      runGeometryPass(pass);
    });
  };

  /**
   * Drop the measurement in hand without touching mount state. §13's opening rule:
   * an invalid measurement must never survive as a placeholder height, and §12
   * rule 6 rejects any in-flight measurement captured under the old fingerprint.
   */
  const invalidateMeasurement = useCallback(
    (record: ContentRowRecord) => {
      // The height is dropped, but the element and the fingerprint capture are kept: the
      // source is still the same one, only its geometry is suspect. Keeping the capture is
      // what lets the mounted element be re-measured immediately instead of waiting for a
      // React update that may never come.
      record.measuredHeight = undefined;
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
      if (record.shellElement) {
        intersectionObserver.current?.observe(record.shellElement);
      }
      scheduleGeometryPass.current('register');
      return () => {
        pendingSettlements.current.delete(record.token);
        settlementDeadlines.current.delete(record.token);
        intersectionObserver.current?.unobserve(record.shellElement as Element);
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
      const previousHeight = record.measuredHeight;
      record.measuredHeight = height;
      record.settled = false;
      record.mountState = 'MOUNTED_MEASURED_UNSETTLED';
      diagnostics.current.recordAcceptedMeasurement(source);
      // §8.1 step 4 — the row settles after this measurement plus two quiet frames; any
      // further resize restarts the count, so "quiet" means "no resize in between".
      if (source === 'resize-observer' && previousHeight != null) {
        scheduleAsyncCorrection(record, height - previousHeight);
      }
      pendingSettlements.current.set(record.token, CONTENT_ROW_QUIET_FRAMES);
      scheduleSettlementLoop.current();
      releaseMeasurementWaiters(record);
    },
    [releaseMeasurementWaiters, scheduleAsyncCorrection],
  );

  /** Re-measure a mounted row from its current element, after an invalidation. */
  const remeasureRow = useCallback(
    (record: ContentRowRecord) => {
      if (!record.mounted || !record.measuredElement) {
        return;
      }
      reportMountedContentHeight(
        record.token,
        record.generation,
        record.layoutBucket,
        record.measuredElement,
        readElementBorderBoxHeight(record.measuredElement),
        'layout-effect',
      );
    },
    [reportMountedContentHeight],
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
   * Hold a row mounted for a reason (§7.2). A pinned row is mounted immediately and cannot
   * become a placeholder while the pin is held; releasing it schedules a normal pass.
   */
  const pinRow = useCallback(
    (token: ContentRowToken, reason: ContentRowPinReason) => {
      const record = rows.current.get(token);
      if (!record) {
        return () => {};
      }
      record.pins.add(reason);
      diagnostics.current.recordPin(reason);
      mountRow(record);
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        record.pins.delete(reason);
        diagnostics.current.recordUnpin(reason);
        scheduleGeometryPass.current('pin-release');
      };
    },
    [mountRow],
  );

  /**
   * Mount everything for a screenshot, find, selection, or debug capture (§17.1, §20.7.5–.6).
   *
   * Readiness barriers are honoured: the caller's capture runs only after fonts are ready,
   * every registered asynchronous renderer has reported ready, and two quiet frames have
   * passed — bounded by a real timeout so a suspended animation frame can never hang the
   * capture. On both success and timeout the returned cleanup restores normal windowing and
   * the previous scroll position.
   */
  const materializeAll = useCallback(
    (reason: ContentRowMaterializeReason) => {
      const root = scrollRootRef.current;
      const previousScrollTop = root?.scrollTop;
      materializationMode.current = reason;
      flushSync(() => {
        rows.current.forEach((record) => {
          mountRow(record);
        });
      });

      const cleanup = () => {
        materializationMode.current = 'none';
        if (root && previousScrollTop != null) {
          root.scrollTop = previousScrollTop;
        }
        scheduleGeometryPass.current('materialize');
      };

      const ready = () => {
        if (root && previousScrollTop != null) {
          root.scrollTop = previousScrollTop;
        }
      };

      return new Promise<() => void>((resolve) => {
        let settled = false;
        const finish = (timedOut: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timedOut) {
            diagnostics.current.recordMaterializeTimeout(reason);
          }
          resolve(cleanup);
        };
        const timer = setTimeout(() => finish(true), MATERIALIZE_SETTLE_TIMEOUT_MS);

        const barriers: Array<Promise<unknown>> = [];
        rows.current.forEach((record) => {
          if (record.readinessPending > 0) {
            barriers.push(
              new Promise<void>((done) => {
                const check = () => {
                  if (record.readinessPending === 0) {
                    done();
                    return;
                  }
                  requestAnimationFrame(check);
                };
                check();
              }),
            );
          }
        });

        const fonts = (typeof document === 'undefined' ? undefined : document.fonts) as
          | FontFaceSet
          | undefined;
        if (fonts?.ready && typeof fonts.ready.then === 'function') {
          barriers.push(fonts.ready);
        }

        Promise.all(barriers)
          .catch(() => undefined)
          .then(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                clearTimeout(timer);
                ready();
                finish(false);
              });
            });
          });
      });
    },
    [mountRow, scrollRootRef],
  );

  /**
   * Synchronous materialization for native find and Ctrl/Meta+A (§20.7.8): text must be in
   * the DOM before the default browser action runs, so this commits at the event boundary and
   * deliberately skips fonts and layout settling.
   */
  const materializeAllSync = useCallback(
    (reason: 'find' | 'selection') => {
      materializationMode.current = reason;
      flushSync(() => {
        rows.current.forEach((record) => {
          mountRow(record);
        });
      });
    },
    [mountRow],
  );

  /**
   * Invalidate the measurements of the affected rows and re-evaluate (§7.2). Used when content
   * changes shape without changing identity, e.g. after an edit or a content layout change.
   */
  const notifyLayoutChange = useCallback(
    (scope: { token?: ContentRowToken; messageId?: string }) => {
      const affected = scope.token != null ? [rows.current.get(scope.token)] : [];
      if (scope.messageId != null) {
        affected.push(...(byMessageId.current.get(scope.messageId) ?? []));
      }
      affected.forEach((record) => {
        if (!record) {
          return;
        }
        invalidateMeasurement(record);
        remeasureRow(record);
      });
      scheduleGeometryPass.current('layout-change');
    },
    [invalidateMeasurement, remeasureRow],
  );

  /**
   * Resolve the message shell that owns a message's rows, mounting them and waiting for a
   * current-generation real measurement (§20.7.2, §20.7.4).
   *
   * A placeholder measurement cannot satisfy this: the wait is released only by an accepted
   * measurement for the generation that is mounted now, and is bounded by a timeout so a jump
   * can never hang.
   */
  const ensureMessageContentMounted = useCallback(
    async (messageId: string) => {
      const records = byMessageId.current.get(messageId);
      if (!records || records.size === 0) {
        return null;
      }
      const list = [...records];
      let shell: HTMLElement | null = null;
      list.forEach((record) => {
        mountRow(record);
        shell = shell ?? messageShellOf(record);
      });
      await Promise.all(
        list.map(
          (record) =>
            new Promise<void>((resolve) => {
              if (
                record.measuredHeight != null &&
                record.measuredFingerprint === record.fingerprint &&
                record.mounted
              ) {
                resolve();
                return;
              }
              let done = false;
              const finish = () => {
                if (done) {
                  return;
                }
                done = true;
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(() => {
                record.measurementWaiters.delete(finish);
                finish();
              }, NAVIGATION_MEASUREMENT_TIMEOUT_MS);
              record.measurementWaiters.add(finish);
            }),
        ),
      );
      return shell;
    },
    [mountRow],
  );

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
      pinRow,
      materializeAll,
      materializeAllSync,
      notifyLayoutChange,
      getLayoutBucket,
      ensureMessageContentMounted,
      getDiagnostics,
    }),
    [
      pinRow,
      materializeAll,
      materializeAllSync,
      notifyLayoutChange,
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

  /**
   * One provider-level intersection observer over persistent row shells (§20.2.1) and one
   * scroll listener that schedules at most one geometry pass per frame (§10).
   *
   * The observer's entries are deliberately ignored: the geometry pass re-reads every
   * rectangle it needs in one batch, so an entry is only a signal that something changed.
   */
  useEffect(() => {
    const root = scrollRootRef.current;
    const loop = geometryLoop.current;
    const asyncCorrectionState = asyncCorrection.current;
    const teardown = () => {
      if (loop.frame != null) {
        cancelAnimationFrame(loop.frame);
        loop.frame = undefined;
      }
    };
    if (!root) {
      return teardown;
    }
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(() => scheduleGeometryPass.current('observer'), {
        root,
        rootMargin: `${CONTENT_ROW_OVERSCAN_PX}px 0px`,
        threshold: 0,
      });
      intersectionObserver.current = observer;
      rows.current.forEach((record) => {
        if (record.shellElement) {
          observer?.observe(record.shellElement);
        }
      });
    }
    const onScroll = () => {
      const top = root.scrollTop;
      const previous = lastScrollTop.current;
      if (previous != null && top !== previous) {
        const direction = top > previous ? 1 : -1;
        if (direction !== lastScrollDirection.current) {
          lastScrollDirection.current = direction;
          // §10 step 7 — a direction change invalidates queued priority decisions.
          directionEpoch.current += 1;
        }
      }
      lastScrollTop.current = top;
      scheduleGeometryPass.current('scroll');
    };
    // §11.4 — while this provider owns correction, native anchoring must not also run.
    const previousOverflowAnchor = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';

    root.addEventListener('scroll', onScroll, { passive: true });
    scheduleGeometryPass.current('observer-init');
    return () => {
      root.style.overflowAnchor = previousOverflowAnchor;
      root.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      intersectionObserver.current = undefined;
      teardown();
      if (asyncCorrectionState.frame != null) {
        cancelAnimationFrame(asyncCorrectionState.frame);
        asyncCorrectionState.frame = undefined;
      }
      asyncCorrectionState.pending = 0;
    };
  }, [conversationId, scrollRootRef]);

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
    conversationEpoch.current += 1;
    diagnostics.current.startWarmUp();
    scheduleGeometryPass.current('conversation');
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

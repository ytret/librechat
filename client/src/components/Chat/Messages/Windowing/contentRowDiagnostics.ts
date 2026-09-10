/**
 * Development-only diagnostics for content-row windowing.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md` §23.
 *
 * The collector is a plain counter bag. The provider owns the registry and
 * supplies live row state when a snapshot is requested, so this module never
 * holds DOM references or message content.
 *
 * Two things matter for the Stage 2 gate:
 *
 * - `staleMeasurementsAccepted` must be zero. It exists as an explicit counter so
 *   that "stale/placeholder measurements accepted: zero" is one read, not an
 *   inference.
 * - Diagnostics are gated behind development builds and expose nothing beyond
 *   what the DOM already renders (row keys, kinds, counts, timings).
 */

import {
  CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT,
  type ContentRowDiagnosticsLive,
  type ContentRowDiagnosticsSnapshot,
  type ContentRowFrameStats,
  type ContentRowKind,
  type ContentRowMaterializeReason,
  type ContentRowMountState,
  type ContentRowPinReason,
  type ContentRowRecord,
  type ContentRowRejectReason,
  type ContentRowReflowState,
  type ContentRowTimeoutDetail,
  type ContentRowValueStats,
  type LayoutBucket,
} from './contentRowTypes';

export const CONTENT_ROW_DIAGNOSTICS_GLOBAL_KEY = '__lcContentRows';

export type ContentRowMountBatchDiagnostics = {
  mounts: number;
  unmounts: number;
  durationMs: number;
  /** Signed anchor displacement observed around the batch, in CSS pixels. */
  anchorDisplacement: number;
  /** Signed scroll write actually applied, in CSS pixels. */
  anchorCorrection: number;
};

export type ContentRowDiagnosticsCollector = {
  recordRegistration(count?: number): void;
  recordUnregistration(count?: number): void;
  recordAcceptedMeasurement(source: 'layout-effect' | 'resize-observer'): void;
  recordRejectedMeasurement(reason: ContentRowRejectReason): void;
  /** Should never be called. Exists so a bug becomes a visible counter, not silence. */
  recordStaleMeasurementAccepted(): void;
  recordPin(reason: ContentRowPinReason): void;
  recordUnpin(reason: ContentRowPinReason): void;
  recordSettleTimeout(detail: ContentRowTimeoutDetail): void;
  recordReadinessTimeout(detail: ContentRowTimeoutDetail): void;
  recordMaterializeTimeout(reason: ContentRowMaterializeReason): void;
  recordMountBatch(batch: ContentRowMountBatchDiagnostics): void;
  recordViewportBypass(count: number): void;
  recordOverBudgetCorrection(): void;
  startWarmUp(at?: number): void;
  completeWarmUp(at?: number): void;
  snapshot(live: ContentRowDiagnosticsLive): ContentRowDiagnosticsSnapshot;
  reset(): void;
};

export function createKindCountMap(): Record<ContentRowKind, number> {
  return {
    markdown: 0,
    'tool-group': 0,
    reasoning: 0,
    summary: 0,
    image: 0,
    artifact: 0,
    'parallel-section': 0,
    subagent: 0,
    generic: 0,
  };
}

export function createMountStateCountMap(): Record<ContentRowMountState, number> {
  return {
    MOUNTED_UNMEASURED: 0,
    MOUNTED_MEASURED_UNSETTLED: 0,
    MOUNTED_MEASURED_SETTLED: 0,
    PLACEHOLDER_MEASURED: 0,
  };
}

export function createRejectReasonCountMap(): Record<ContentRowRejectReason, number> {
  return {
    'no-record': 0,
    'unknown-element': 0,
    'not-mounted': 0,
    'element-mismatch': 0,
    'generation-mismatch': 0,
    'bucket-mismatch': 0,
    'fingerprint-mismatch': 0,
    'invalid-height': 0,
  };
}

export function createPinReasonCountMap(): Record<ContentRowPinReason, number> {
  return {
    focus: 0,
    selection: 0,
    editing: 0,
    streaming: 0,
    animation: 0,
    portal: 0,
    interaction: 0,
    navigation: 0,
    materialize: 0,
    latest: 0,
    submitting: 0,
    'settlement-timeout': 0,
    debug: 0,
  };
}

/** Empty live state, used before any row registers (and by tests). */
export function createEmptyDiagnosticsLive(): ContentRowDiagnosticsLive {
  return {
    registeredRows: 0,
    mountedRows: 0,
    placeholderRows: 0,
    unmeasuredRows: 0,
    unsettledRows: 0,
    staleRows: 0,
    forcedRows: 0,
    oversizedRows: 0,
    alwaysMountedRows: 0,
    totalByKind: createKindCountMap(),
    mountedByKind: createKindCountMap(),
    mountStates: createMountStateCountMap(),
    measuredHeightDistribution: summarizeValues([]),
    layoutBucket: null,
    reflowState: 'idle',
  };
}

/**
 * Derive the §23 live section from the provider's registry.
 *
 * Pure over records, so the counting rules can be unit tested without a browser.
 *
 * - `unmeasuredRows` — no accepted height for the current generation.
 * - `unsettledRows` — mounted but not yet settled (and therefore not
 *   unmount-eligible).
 * - `staleRows` — the measurement in hand was taken under a fingerprint that no
 *   longer describes the source. Non-zero outside a transition means the
 *   invalidation path leaked.
 */
export function createLiveDiagnosticsState(
  records: Iterable<ContentRowRecord>,
  state: { layoutBucket: LayoutBucket | null; reflowState: ContentRowReflowState },
): ContentRowDiagnosticsLive {
  const live = createEmptyDiagnosticsLive();
  live.layoutBucket = state.layoutBucket;
  live.reflowState = state.reflowState;
  const heights: number[] = [];

  for (const record of records) {
    live.registeredRows += 1;
    live.totalByKind[record.kind] += 1;
    live.mountStates[record.mountState] += 1;

    if (record.mounted) {
      live.mountedRows += 1;
      live.mountedByKind[record.kind] += 1;
    } else {
      live.placeholderRows += 1;
    }

    if (record.measuredHeight == null) {
      live.unmeasuredRows += 1;
    } else {
      heights.push(record.measuredHeight);
    }

    if (record.mounted && !record.settled) {
      live.unsettledRows += 1;
    }
    if (record.measuredFingerprint !== record.fingerprint) {
      live.staleRows += 1;
    }
    if (record.forceMounted) {
      live.forcedRows += 1;
    }
    if (record.oversized) {
      live.oversizedRows += 1;
    }
    if (record.policy === 'always-mounted' || record.pinnedByPolicy != null) {
      live.alwaysMountedRows += 1;
    }
  }

  live.measuredHeightDistribution = summarizeValues(heights);
  return live;
}

/**
 * Nearest-rank percentile, matching `ai-reports/stage0/extract-recalc.py` so
 * windowing diagnostics and the frozen trace harness agree.
 */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index];
}

export function summarizeValues(values: number[]): ContentRowValueStats {
  if (values.length === 0) {
    return { count: 0, total: 0, min: null, max: null, mean: null, p50: null, p95: null };
  }
  let total = 0;
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    total += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    total,
    min,
    max,
    mean: total / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

export function summarizeFrames(counts: number[]): ContentRowFrameStats {
  if (counts.length === 0) {
    return { frames: 0, total: 0, max: 0, mean: null };
  }
  let total = 0;
  let max = 0;
  for (const count of counts) {
    total += count;
    if (count > max) max = count;
  }
  return { frames: counts.length, total, max, mean: total / counts.length };
}

function pushBounded<T>(list: T[], value: T): void {
  if (list.length >= CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT) {
    list.shift();
  }
  list.push(value);
}

export function createContentRowDiagnostics(): ContentRowDiagnosticsCollector {
  let registrations = 0;
  let unregistrations = 0;
  let acceptedMeasurements = 0;
  let acceptedFromLayoutEffect = 0;
  let acceptedFromResizeObserver = 0;
  let staleMeasurementsAccepted = 0;
  let settlementTimeouts = 0;
  let readinessTimeouts = 0;
  let materializationTimeouts = 0;
  let overBudgetCorrections = 0;
  let viewportBudgetBypass = 0;
  let warmUpStartedAt: number | null = null;
  let warmUpDurationMs: number | null = null;
  let warmUpComplete = false;

  let rejectedByReason = createRejectReasonCountMap();
  let pinsByReason = createPinReasonCountMap();
  const settlementTimeoutDetails: ContentRowTimeoutDetail[] = [];
  const readinessTimeoutDetails: ContentRowTimeoutDetail[] = [];
  const materializationTimeoutDetails: string[] = [];
  const mountCountsPerFrame: number[] = [];
  const unmountCountsPerFrame: number[] = [];
  const mountTransactionDurations: number[] = [];
  const anchorDisplacements: number[] = [];
  const anchorCorrections: number[] = [];

  return {
    recordRegistration(count = 1) {
      registrations += count;
    },
    recordUnregistration(count = 1) {
      unregistrations += count;
    },
    recordAcceptedMeasurement(source) {
      acceptedMeasurements += 1;
      if (source === 'layout-effect') {
        acceptedFromLayoutEffect += 1;
      } else {
        acceptedFromResizeObserver += 1;
      }
    },
    recordRejectedMeasurement(reason) {
      rejectedByReason[reason] += 1;
    },
    recordStaleMeasurementAccepted() {
      staleMeasurementsAccepted += 1;
    },
    recordPin(reason) {
      pinsByReason[reason] += 1;
    },
    recordUnpin(reason) {
      pinsByReason[reason] = Math.max(0, pinsByReason[reason] - 1);
    },
    recordSettleTimeout(detail) {
      settlementTimeouts += 1;
      pushBounded(settlementTimeoutDetails, detail);
    },
    recordReadinessTimeout(detail) {
      readinessTimeouts += 1;
      pushBounded(readinessTimeoutDetails, detail);
    },
    recordMaterializeTimeout(reason) {
      materializationTimeouts += 1;
      pushBounded(materializationTimeoutDetails, reason);
    },
    recordMountBatch(batch) {
      mountCountsPerFrame.push(batch.mounts);
      unmountCountsPerFrame.push(batch.unmounts);
      mountTransactionDurations.push(batch.durationMs);
      anchorDisplacements.push(batch.anchorDisplacement);
      anchorCorrections.push(batch.anchorCorrection);
    },
    recordViewportBypass(count) {
      viewportBudgetBypass += count;
    },
    recordOverBudgetCorrection() {
      overBudgetCorrections += 1;
    },
    startWarmUp(at = Date.now()) {
      warmUpStartedAt = at;
      warmUpComplete = false;
      warmUpDurationMs = null;
    },
    completeWarmUp(at = Date.now()) {
      warmUpComplete = true;
      warmUpDurationMs = warmUpStartedAt == null ? null : at - warmUpStartedAt;
    },
    snapshot(live) {
      return {
        ...live,
        registrations,
        unregistrations,
        acceptedMeasurements,
        acceptedMeasurementsBySource: {
          'layout-effect': acceptedFromLayoutEffect,
          'resize-observer': acceptedFromResizeObserver,
        },
        rejectedMeasurements: Object.values(rejectedByReason).reduce((a, b) => a + b, 0),
        rejectedByReason: { ...rejectedByReason },
        staleMeasurementsAccepted,
        pinsByReason: { ...pinsByReason },
        settlementTimeouts,
        settlementTimeoutDetails: [...settlementTimeoutDetails],
        readinessTimeouts,
        readinessTimeoutDetails: [...readinessTimeoutDetails],
        materializationTimeouts,
        materializationTimeoutDetails: [...materializationTimeoutDetails],
        overBudgetCorrections,
        viewportBudgetBypass,
        mountCountsPerFrame: summarizeFrames(mountCountsPerFrame),
        unmountCountsPerFrame: summarizeFrames(unmountCountsPerFrame),
        mountTransactionDurations: summarizeValues(mountTransactionDurations),
        anchorDisplacement: summarizeValues(anchorDisplacements),
        anchorCorrection: summarizeValues(anchorCorrections),
        warmUpDurationMs,
        warmUpComplete,
      };
    },
    reset() {
      registrations = 0;
      unregistrations = 0;
      acceptedMeasurements = 0;
      acceptedFromLayoutEffect = 0;
      acceptedFromResizeObserver = 0;
      staleMeasurementsAccepted = 0;
      settlementTimeouts = 0;
      readinessTimeouts = 0;
      materializationTimeouts = 0;
      overBudgetCorrections = 0;
      viewportBudgetBypass = 0;
      warmUpStartedAt = null;
      warmUpDurationMs = null;
      warmUpComplete = false;
      rejectedByReason = createRejectReasonCountMap();
      pinsByReason = createPinReasonCountMap();
      settlementTimeoutDetails.length = 0;
      readinessTimeoutDetails.length = 0;
      materializationTimeoutDetails.length = 0;
      mountCountsPerFrame.length = 0;
      unmountCountsPerFrame.length = 0;
      mountTransactionDurations.length = 0;
      anchorDisplacements.length = 0;
      anchorCorrections.length = 0;
    },
  };
}

declare global {
  interface Window {
    __lcContentRows?: {
      snapshot: () => ContentRowDiagnosticsSnapshot;
      reset: () => void;
    };
  }
}

export type InstallContentRowDiagnosticsOptions = {
  /** Defaults to `import.meta.env.DEV`, following `QueryDevtoolsGate`. */
  isDevelopment?: boolean;
  /** Live registry state, supplied by the provider. */
  getLive: () => ContentRowDiagnosticsLive;
};

/**
 * Expose the collector on `window` for console use. Returns an uninstall function.
 * Production builds install nothing, so nothing here can leak in a release.
 */
export function installContentRowDiagnostics(
  collector: ContentRowDiagnosticsCollector,
  { isDevelopment = import.meta.env.DEV, getLive }: InstallContentRowDiagnosticsOptions,
): () => void {
  if (!isDevelopment || typeof window === 'undefined') {
    return () => {};
  }
  const handle = {
    snapshot: () => collector.snapshot(getLive()),
    reset: () => collector.reset(),
  };
  window.__lcContentRows = handle;
  return () => {
    if (window.__lcContentRows === handle) {
      window.__lcContentRows = undefined;
    }
  };
}

/**
 * Shared types and tuning constants for content-row DOM windowing.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md`
 *   §7.2 public provider interface
 *   §7.3 registry record
 *   §7.5 mount state machine
 *   §8.1 settlement timeout
 *   §10 mounting policy constants
 *   §11.1 transition batch
 *   §12 measurement validation
 *   §23 diagnostics
 *
 * This module is the single source of truth for those shapes. It is deliberately
 * free of DOM access so it can be unit tested and imported by both the provider
 * and the dev fixture.
 */

export type ContentRowToken = symbol;
export type MessageScopeToken = symbol;
export type LayoutBucket = string;

/** Row granularity. Markdown rows arrive in Stage 4; tool/parallel/subagent in Stage 3. */
export type ContentRowKind =
  | 'markdown'
  | 'tool-group'
  | 'reasoning'
  | 'summary'
  | 'image'
  | 'artifact'
  | 'parallel-section'
  | 'subagent'
  | 'generic';

/** Whether a row may ever unmount, or must stay mounted for its whole registration. */
export type ContentRowPolicy = 'windowed' | 'always-mounted' | 'unstable-until-settled';

/**
 * Mount state machine (§7.5). Only `MOUNTED_MEASURED_SETTLED` may transition to
 * `PLACEHOLDER_MEASURED`; a fingerprint or bucket change returns the row to
 * `MOUNTED_UNMEASURED` because a now-invalid height must never stay a placeholder.
 */
export type ContentRowMountState =
  | 'MOUNTED_UNMEASURED'
  | 'MOUNTED_MEASURED_UNSETTLED'
  | 'MOUNTED_MEASURED_SETTLED'
  | 'PLACEHOLDER_MEASURED';

export type ContentRowMeasurementSource = 'layout-effect' | 'resize-observer';

/**
 * Why a reported measurement was refused (§12). Closed union so the
 * "stale/placeholder measurements accepted: zero" gate is a single counter read.
 */
export type ContentRowRejectReason =
  /** Rule 1 — no record for this token. */
  | 'no-record'
  /** Observer entry for an element no longer mapped to a live generation. */
  | 'unknown-element'
  /** Rule 2 — record is currently a placeholder. */
  | 'not-mounted'
  /** Rule 3 — record's current measured element is not the reporting element. */
  | 'element-mismatch'
  /** Rule 4 — reporting generation is not the record's current generation. */
  | 'generation-mismatch'
  /** Rule 5 — reporting layout bucket is not the record's current bucket. */
  | 'bucket-mismatch'
  /** Rule 6 — the record's fingerprint changed after this generation started. */
  | 'fingerprint-mismatch'
  /** Rule 7 — height is not finite or is negative. */
  | 'invalid-height';

/**
 * Why a row is pinned (cannot unmount). Derived from §24 ("unmounts focused,
 * edited, selected, streaming, animating, or portal-owning rows" is prohibited)
 * plus the interaction reasons the predecessor provider tracked.
 */
export type ContentRowPinReason =
  | 'focus'
  | 'selection'
  | 'editing'
  | 'streaming'
  | 'animation'
  | 'portal'
  | 'interaction'
  | 'navigation'
  | 'materialize'
  | 'latest'
  | 'submitting'
  | 'debug';

export type ContentRowMaterializeReason = 'screenshot' | 'find' | 'selection' | 'debug';

/** §13 — the provider is either windowing normally or holding all content real. */
export type ContentRowReflowState = 'idle' | 'reflow-materialized';

/** Rendering mode that changes row geometry; part of the layout bucket (§12). */
export type ContentRowRenderingMode = 'markdown' | 'plain';

/**
 * Inputs that define a layout bucket (§12). A measurement is only valid for the
 * bucket it was taken in; a change to any of these invalidates it (§13).
 */
export type LayoutBucketInput = {
  /** Content box width of the scroll root, in CSS pixels. */
  containerWidth: number;
  /** Effective root font size in CSS pixels (captures UI scale / font settings). */
  fontSizePx: number;
  renderingMode: ContentRowRenderingMode;
};

/* -------------------------------------------------------------------------- */
/* §10 mounting policy constants                                              */
/* -------------------------------------------------------------------------- */

export const CONTENT_ROW_OVERSCAN_PX = 800;
export const CONTENT_ROW_UNMOUNT_HYSTERESIS_PX = 1600;
export const MAX_MOUNTS_PER_FRAME = 4;
export const MAX_UNMOUNTS_PER_FRAME = 8;
export const MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX = 100;
export const MAX_ACCEPTED_STEADY_STATE_DISPLACEMENT_PX = 2;

/* -------------------------------------------------------------------------- */
/* Other protocol constants                                                   */
/* -------------------------------------------------------------------------- */

/** §8.1 — per-row settlement timeout; on expiry the row becomes `always-mounted`. */
export const CONTENT_ROW_SETTLEMENT_TIMEOUT_MS = 2000;

/** §8.1 — a row settles after its initial measurement plus two quiet frames. */
export const CONTENT_ROW_QUIET_FRAMES = 2;

/** §11.1 — minimum anchor displacement that is worth a scroll write. */
export const MIN_ANCHOR_CORRECTION_PX = 0.5;

/**
 * Upper bound for settling mounts before a screenshot/debug capture. A real
 * timeout (not only two animation frames) guarantees cleanup still runs when
 * animation frames are suspended (background tab, throttled webview, etc.).
 * Same value the predecessor provider used.
 */
export const MATERIALIZE_SETTLE_TIMEOUT_MS = 500;

/** Upper bound for waiting on a current-generation measurement during navigation. */
export const NAVIGATION_MEASUREMENT_TIMEOUT_MS = 250;

/** §13 step 7 — resize must be quiet this long before reflow settlement begins. */
export const REFLOW_RESIZE_QUIET_MS = 150;

/** Maximium number of detail records retained for timeout diagnostics (§23). */
export const CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT = 50;

/* -------------------------------------------------------------------------- */
/* §7.2 provider interface                                                    */
/* -------------------------------------------------------------------------- */

export type ContentRowRegistration = {
  token: ContentRowToken;
  scopeToken: MessageScopeToken;
  messageId: string;
  /** Diagnostics only; never cache identity. Stable across a measurement's life. */
  debugKey: string;
  kind: ContentRowKind;
  /** Determines whether a previous measurement still describes the rendered source. */
  fingerprint: string;
  policy: ContentRowPolicy;
  forceMounted: boolean;
  shellElement: HTMLElement;
  /**
   * Row-owned mount setter. Receives the generation it is being set for and, when
   * becoming a placeholder, the exact last accepted border-box height (§6 #4).
   */
  setMounted(mounted: boolean, generation: number, height?: number): void;
};

export type MountedContentRegistration = {
  token: ContentRowToken;
  generation: number;
  layoutBucket: LayoutBucket;
  element: HTMLElement;
};

/**
 * Fields a row may change after registration. Deliberately excludes `kind` and
 * `scopeToken`: a kind change is a new row (new token), not an update.
 */
export type ContentRowUpdate = Partial<
  Pick<ContentRowRegistration, 'messageId' | 'debugKey' | 'fingerprint' | 'policy' | 'forceMounted'>
>;

export type ContentRowWindowingContextValue = {
  registerRow(registration: ContentRowRegistration): () => void;
  updateRow(token: ContentRowToken, update: ContentRowUpdate): void;
  registerMountedContent(registration: MountedContentRegistration): () => void;
  reportMountedContentHeight(
    token: ContentRowToken,
    generation: number,
    layoutBucket: LayoutBucket,
    element: HTMLElement,
    height: number,
    source: ContentRowMeasurementSource,
  ): void;
  markRowSettled(token: ContentRowToken, generation: number): void;
  pinRow(token: ContentRowToken, reason: ContentRowPinReason): () => void;
  ensureMessageContentMounted(messageId: string): Promise<HTMLElement | null>;
  materializeAll(reason: ContentRowMaterializeReason): Promise<() => void>;
  materializeAllSync(reason: 'find' | 'selection'): void;
  notifyLayoutChange(scope: { token?: ContentRowToken; messageId?: string }): void;
  getDiagnostics(): ContentRowDiagnosticsSnapshot;
  /**
   * Extension beyond §7.2. §7.2's `registerMountedContent` requires the caller to
   * supply the layout bucket, so a row needs a way to read the provider's current
   * bucket. The provider remains the owner of bucket changes (§12, §13).
   */
  getLayoutBucket(): LayoutBucket;
  /**
   * Extension beyond §7.2. §8.2 requires rows with asynchronous renderers
   * (images, Mermaid, artifacts) to "report ready" but does not name an API.
   * A row registers a promise that must settle before the row may become settled
   * and therefore unmount-eligible. Returns an unsubscribe function.
   */
  registerReadiness(
    token: ContentRowToken,
    generation: number,
    readiness: Promise<unknown>,
  ): () => void;
};

/**
 * The subset of the §7.2 interface a consumer may use at the current stage.
 *
 * Stage 2 grows this monotonically (2.3 adds measurement reporting, 2.4 settlement,
 * 2.8 pins and materialization) and task 2.8 asserts the provider satisfies the full
 * `ContentRowWindowingContextValue` with `satisfies`. Keeping the consumer-facing type
 * narrow means an intermediate commit never exposes a member whose implementation has
 * not landed.
 */
export type ContentRowWindowingRuntime = Pick<
  ContentRowWindowingContextValue,
  | 'registerRow'
  | 'updateRow'
  | 'registerMountedContent'
  | 'reportMountedContentHeight'
  | 'getLayoutBucket'
  | 'ensureMessageContentMounted'
  | 'getDiagnostics'
>;

/* -------------------------------------------------------------------------- */
/* §7.3 registry record                                                       */
/* -------------------------------------------------------------------------- */

export type ContentRowRecord = {
  token: ContentRowToken;
  scopeToken: MessageScopeToken;
  messageId: string;
  /**
   * Conversation the record was registered in. Not part of §7.3: it exists so a
   * conversation change can invalidate rows whose component position was reused
   * without racing rows registering for the new conversation in the same commit.
   */
  conversationId: string | null;
  debugKey: string;
  kind: ContentRowKind;
  fingerprint: string;
  policy: ContentRowPolicy;
  shellElement: HTMLElement | null;
  measuredElement: HTMLElement | null;
  mounted: boolean;
  committedMounted: boolean;
  generation: number;
  layoutBucket: LayoutBucket;
  measuredHeight?: number;
  /**
   * Fingerprint captured when the current generation started. A measurement is
   * accepted only while this still equals `fingerprint` (§12 rule 6), which is
   * what makes an in-place source change invalidate the old measurement.
   */
  measuredFingerprint?: string;
  mountState: ContentRowMountState;
  settled: boolean;
  forceMounted: boolean;
  oversized: boolean;
  /** Reason the row can never unmount, e.g. a settlement timeout (§8.1). */
  pinnedByPolicy: ContentRowPinReason | null;
  pins: Set<ContentRowPinReason>;
  /**
   * Released when a caller waiting on a current-generation measurement can proceed
   * (§20.7.2). Declared with the record so the settle path does not have to grow
   * the record shape later.
   */
  measurementWaiters: Set<() => void>;
  setMounted(mounted: boolean, generation: number, height?: number): void;
  commitWaiters: Set<() => void>;
};

/**
 * Fields the §12 acceptance test reads. Splitting them out lets the whole rule
 * set be unit tested without constructing a full registry record.
 */
export type ContentRowMeasurementTarget = Pick<
  ContentRowRecord,
  'mounted' | 'measuredElement' | 'generation' | 'layoutBucket' | 'fingerprint'
> & {
  measuredFingerprint?: string;
};

/* -------------------------------------------------------------------------- */
/* §23 diagnostics                                                            */
/* -------------------------------------------------------------------------- */

export type ContentRowValueStats = {
  count: number;
  total: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Nearest-rank percentiles, consistent with `ai-reports/stage0/extract-recalc.py`. */
  p50: number | null;
  p95: number | null;
};

export type ContentRowFrameStats = {
  frames: number;
  total: number;
  max: number;
  mean: number | null;
};

export type ContentRowTimeoutDetail = {
  debugKey: string;
  kind: ContentRowKind;
  elapsedMs: number;
};

/** Live registry state, supplied by the provider when a snapshot is taken. */
export type ContentRowDiagnosticsLive = {
  registeredRows: number;
  mountedRows: number;
  placeholderRows: number;
  unmeasuredRows: number;
  unsettledRows: number;
  staleRows: number;
  forcedRows: number;
  oversizedRows: number;
  alwaysMountedRows: number;
  totalByKind: Record<ContentRowKind, number>;
  mountedByKind: Record<ContentRowKind, number>;
  mountStates: Record<ContentRowMountState, number>;
  /** Statistic over the measured heights of all rows that currently hold one. */
  measuredHeightDistribution: ContentRowValueStats;
  layoutBucket: LayoutBucket | null;
  reflowState: ContentRowReflowState;
};

/** Full development-only snapshot (§23). Never contains message text. */
export type ContentRowDiagnosticsSnapshot = ContentRowDiagnosticsLive & {
  registrations: number;
  unregistrations: number;
  acceptedMeasurements: number;
  acceptedMeasurementsBySource: Record<ContentRowMeasurementSource, number>;
  rejectedMeasurements: number;
  rejectedByReason: Record<ContentRowRejectReason, number>;
  /** Must be zero: a placeholder or stale measurement must never be accepted. */
  staleMeasurementsAccepted: number;
  pinsByReason: Record<ContentRowPinReason, number>;
  settlementTimeouts: number;
  settlementTimeoutDetails: ContentRowTimeoutDetail[];
  readinessTimeouts: number;
  readinessTimeoutDetails: ContentRowTimeoutDetail[];
  materializationTimeouts: number;
  materializationTimeoutDetails: string[];
  overBudgetCorrections: number;
  viewportBudgetBypass: number;
  mountCountsPerFrame: ContentRowFrameStats;
  unmountCountsPerFrame: ContentRowFrameStats;
  mountTransactionDurations: ContentRowValueStats;
  anchorDisplacement: ContentRowValueStats;
  anchorCorrection: ContentRowValueStats;
  warmUpDurationMs: number | null;
  warmUpComplete: boolean;
};

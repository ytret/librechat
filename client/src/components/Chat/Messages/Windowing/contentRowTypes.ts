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
  /** §8.1 — the row exceeded the settlement timeout, so it is effectively
   *  always-mounted and must never become a placeholder. */
  | 'settlement-timeout'
  /** The row settled and re-unsettled too many times; treated as permanently unstable. */
  | 'unstable'
  /** §11.3 — an asynchronous resize needed a correction above the development budget. */
  | 'async-correction'
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
/**
 * How far ahead to mount, in milliseconds of measured travel. A fixed lead cannot keep up with a
 * fast fling: at high velocity the reader crosses more than the lead distance within one frame,
 * so rows enter the viewport before any pass has considered them and the viewport renders empty.
 * Scaling the lead by measured velocity is what §10 sanctions ("adjust lead based on measured
 * mount cost/velocity") in preference to raising the global overscan.
 */
export const CONTENT_ROW_VELOCITY_LEAD_MS = 220;
/** Upper bound on the velocity-scaled lead, so a fling cannot mount the whole conversation. */
export const CONTENT_ROW_MAX_LEAD_PX = 4800;
/** Exponential smoothing factor for scroll velocity; lower is smoother and less reactive. */
export const CONTENT_ROW_VELOCITY_SMOOTHING = 0.35;
/** Velocity below this (px/ms) is treated as stationary, so the base lead applies. */
export const CONTENT_ROW_VELOCITY_MIN_PX_PER_MS = 0.5;
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

/**
 * How many times the provider will try to bring one row to a stable settled state before
 * treating its geometry as permanently unstable and keeping it mounted for good.
 *
 * The §8.1 budget alone is not sufficient. §8.2 assumes a row that "keeps resizing ... never
 * settles", but a row whose resize cadence is slower than
 * `CONTENT_ROW_QUIET_FRAMES` settles in the gaps between resizes: it settles, changes, settles
 * again, and each cycle costs a geometry pass and a settlement pass forever. Bounding the
 * number of attempts makes that case terminate deterministically, which is what guarantees the
 * provider goes idle.
 */
export const MAX_SETTLEMENT_ATTEMPTS = 3;

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
  | 'markRowSettled'
  | 'registerReadiness'
  | 'pinRow'
  | 'materializeAll'
  | 'materializeAllSync'
  | 'notifyLayoutChange'
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
  /**
   * Settlement budgets armed for this row's current generation. Bounded by
   * `MAX_SETTLEMENT_ATTEMPTS` so a row that settles and re-unsettles cannot cycle forever.
   */
  settlementAttempts: number;
  /** When the current settlement attempt sequence began, for timeout diagnostics. */
  settlementStartedAt: number | null;
  pins: Set<ContentRowPinReason>;
  /**
   * Number of registered asynchronous renderers that have not reported ready (§8.2).
   * A row with pending readiness cannot settle, and therefore cannot unmount. Not part
   * of §7.3: the spec requires the readiness behaviour but names no field for it.
   */
  readinessPending: number;
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

/** Which trigger scheduled a geometry pass. Attribution for the idle-work check. */
/** Which call path armed a settlement budget. Diagnostic attribution for attempt counts. */
export type ContentRowAttemptSource =
  | 'register'
  | 'mount'
  | 'content'
  | 'rearm'
  | 'invalidate'
  | 'generation';

export type ContentRowPassScheduleReason =
  | 'register'
  | 'warm-up'
  | 'settled'
  | 'deferred'
  | 'pin-release'
  | 'materialize'
  | 'layout-change'
  | 'conversation'
  | 'observer'
  | 'observer-init'
  | 'scroll'
  | 'discard';

/** Why a scheduled geometry pass was discarded before doing any work (§10 step 7). */
export type ContentRowPassDiscardReason =
  | 'conversation-changed'
  | 'direction-changed'
  | 'bucket-changed'
  | 'materializing'
  | 'no-root';

export type ContentRowTimeoutDetail = {
  debugKey: string;
  kind: ContentRowKind;
  elapsedMs: number;
  /** Which condition demoted the row. */
  reason: ContentRowDemotionReason;
  /** Settlement attempts spent on this row in its current mounted window. */
  attempts: number;
};

/**
 * Why a row was demoted to an effective always-mounted policy.
 *
 * - `budget-expired` — the §8.1 settlement budget elapsed while the row was still unsettled.
 * - `too-many-attempts` — the row kept settling and re-unsettling, so no single budget ever
 *   expired; it is treated as permanently unstable instead.
 */
export type ContentRowDemotionReason = 'budget-expired' | 'too-many-attempts';

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
  /**
   * Settlement bookkeeping, read live from the provider rather than sampled at pass time.
   * Sampling would freeze these at their pre-cleanup values the moment the loop went idle,
   * which reads as "one row is stuck pending" when nothing is actually pending.
   */
  pendingSettlementRows: number;
  settlementDeadlineRows: number;
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
  /** Corrections applied for later asynchronous resizes (§11.3), not mount batches. */
  asyncCorrection: ContentRowValueStats;
  /**
   * Geometry passes that were discarded before doing any work, by reason (§10 step 7). A
   * non-zero count is normal after a direction change or a bucket change; a count that keeps
   * climbing while nothing else happens means passes are never being applied.
   */
  discardedPasses: Record<ContentRowPassDiscardReason, number>;
  /** Completed geometry passes, i.e. passes that classified rows and applied a batch. */
  appliedPasses: number;
  /** Total geometry passes scheduled. */
  scheduledPasses: number;
  /** Largest mount lead actually used, after velocity scaling. */
  maxLeadPx: number;
  /** Largest distance the reader moved between two scroll events, in CSS pixels. */
  maxScrollDeltaPx: number;
  /** Largest single scroll event delta that produced a blank-viewport pass. */
  maxScrollDeltaOnBlankPassPx: number;
  /** Settlement attempts armed, by call path. Names which path spends the attempt budget. */
  attemptsBySource: Record<ContentRowAttemptSource, number>;
  /** Geometry passes run synchronously at an event boundary, for a jump larger than the lead. */
  synchronousPasses: number;
  /** Large-jump passes that ended up mounting nothing: each is a blank frame the reader saw. */
  blankLargeJumpPasses: number;
  /** Unmount candidates considered by the most recent blank large-jump pass. */
  blankLargeJumpUnmountCandidates: number;
  /** Lead used by that pass. */
  blankLargeJumpLead: number;
  /** Unmount hysteresis in force during that pass. */
  blankLargeJumpHysteresis: number;
  /**
   * Geometry passes that ran with no mounted row intersecting the viewport while rows were
   * registered: each one is a moment the reader saw empty background. Must stay zero during
   * ordinary scrolling, including a fling.
   */
  blankViewportPasses: number;
  /** Schedules attributed to their trigger, so idle work can be traced to a cause. */
  scheduledByReason: Record<ContentRowPassScheduleReason, number>;
  /** Settlement-loop passes run. A frozen value means the loop is idle. */
  settlementPasses: number;
  /** Writes to scrollTop made by the provider, in total. */
  scrollWrites: number;
  warmUpDurationMs: number | null;
  warmUpComplete: boolean;
};

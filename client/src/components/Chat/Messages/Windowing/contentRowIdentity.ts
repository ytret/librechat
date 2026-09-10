/**
 * Content-row identity and measurement-acceptance primitives.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md` §7.1, §7.4, §12.
 *
 * Three identity concepts, deliberately kept separate:
 *
 * - **token** — component-instance identity (`Symbol`). Survives a client-ID to
 *   server-ID replacement because React position, not the message ID, owns the
 *   component instance (§7.1).
 * - **debugKey** — diagnostics and DOM attributes only. Never cache identity.
 * - **fingerprint** — source/state identity. Decides whether a previous
 *   measurement still describes what is rendered now (§7.3).
 *
 * Cache validity is scoped to `token + fingerprint + layout bucket` (§12).
 *
 * Everything here is pure: no DOM access, no React, no module state. The DOM
 * measurement read lives in the provider because it needs the record.
 */

import type {
  ContentRowKind,
  ContentRowMeasurementTarget,
  ContentRowRejectReason,
  ContentRowToken,
  LayoutBucket,
  LayoutBucketInput,
  MessageScopeToken,
} from './contentRowTypes';

/**
 * Width bucket granularity in CSS pixels.
 *
 * Coarse on purpose: line wrapping does not change for sub-bucket resizes, so
 * bucketing avoids invalidating every measurement during a continuous window
 * resize. 16 px also matches the delta threshold the predecessor provider used
 * before it invalidated anything, so the two behaviours agree at the boundary.
 */
export const CONTENT_ROW_WIDTH_BUCKET_PX = 16;

/** Half-pixel granularity for the font-size bucket. */
export const CONTENT_ROW_FONT_BUCKET_STEP = 0.5;

/** A message-scope token is created once per `MessageShell` instance and never changes. */
export function createScopeToken(): MessageScopeToken {
  return Symbol('content-row-scope');
}

/** A row token is created once per row component instance. */
export function createRowToken(debugKey?: string): ContentRowToken {
  return Symbol(debugKey ?? 'content-row');
}

/** Generations are monotonically increasing per row, starting at 1 (§7.5). */
export function nextGeneration(currentGeneration: number): number {
  return currentGeneration + 1;
}

function bucketOf(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value / step);
}

/**
 * Compute the layout bucket for a row (§12). A measurement taken in one bucket is
 * never used as a placeholder in another.
 */
export function computeLayoutBucket(input: LayoutBucketInput): LayoutBucket {
  const width = bucketOf(input.containerWidth, CONTENT_ROW_WIDTH_BUCKET_PX);
  const font = bucketOf(input.fontSizePx, CONTENT_ROW_FONT_BUCKET_STEP);
  return `w${width}-f${font}-${input.renderingMode}`;
}

export type FingerprintInput = {
  kind: ContentRowKind;
  /**
   * Stable identity of the source inside the message: a split-block index, a
   * content-part index, or a tool call id. Must not change while the same
   * rendered source is reused.
   */
  sourceKey: string | number;
  /**
   * State that changes geometry without changing the source: expanded/collapsed,
   * streaming revision, rendering mode. Expansion state belongs in the
   * fingerprint for rows whose geometry changes with expansion (§12).
   */
  stateKey?: string | number | boolean | null;
  /** Optional hash of the content itself, for sources that can change in place. */
  contentKey?: string;
};

function isFingerprintEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Compose a deterministic fingerprint. Empty parts are omitted so that, e.g.,
 * `stateKey: undefined` and an absent `stateKey` produce the same value.
 */
export function composeFingerprint(input: FingerprintInput): string {
  const parts: string[] = [input.kind, String(input.sourceKey)];
  if (!isFingerprintEmpty(input.stateKey)) {
    parts.push(String(input.stateKey));
  }
  if (!isFingerprintEmpty(input.contentKey)) {
    parts.push(String(input.contentKey));
  }
  return parts.join('|');
}

/** True when the source/state changed and any existing measurement is invalid. */
export function fingerprintChanged(previous: string | undefined, next: string): boolean {
  return previous !== next;
}

/**
 * Diagnostics-only key. Message IDs are already present in the DOM as `.message-render`
 * IDs, so this leaks nothing beyond what is rendered; message *text* must never be
 * included (§23).
 */
export function formatDebugKey(input: {
  messageId: string;
  kind: ContentRowKind;
  ordinal: number;
}): string {
  return `${input.messageId}:${input.kind}:${input.ordinal}`;
}

/** A height is usable only when it is a finite, non-negative number (§12 rule 7). */
export function isAcceptedHeight(height: unknown): height is number {
  return typeof height === 'number' && Number.isFinite(height) && height >= 0;
}

/** Rounding is for diagnostics only; the browser value is what placeholders use (§12). */
export function roundForDiagnostics(height: number): number {
  return Math.round(height * 10) / 10;
}

export type MeasurementVerdict =
  | { accepted: true }
  | { accepted: false; reason: ContentRowRejectReason };

export type MeasurementObservation = {
  /** The element that produced the observation. Compared by identity. */
  element: HTMLElement | null;
  generation: number;
  layoutBucket: LayoutBucket;
  height: number;
};

/**
 * The §12 acceptance rules, as a pure function of the record's relevant fields.
 *
 * A rejected observation must not overwrite a height, mark a row measured or
 * settled, resolve a waiter, change bottom pinning, or write scroll position.
 * Callers implement that by treating `accepted: false` as a no-op.
 */
export function classifyMeasurement(
  target: ContentRowMeasurementTarget | undefined,
  observation: MeasurementObservation,
): MeasurementVerdict {
  // 1. record exists
  if (!target) {
    return { accepted: false, reason: 'no-record' };
  }
  // 2. record is mounted — a persistent placeholder shell is never a content measurement
  if (!target.mounted) {
    return { accepted: false, reason: 'not-mounted' };
  }
  // 3. the reporting element is exactly the record's current measured element
  if (target.measuredElement == null || target.measuredElement !== observation.element) {
    return { accepted: false, reason: 'element-mismatch' };
  }
  // 4. generation matches
  if (target.generation !== observation.generation) {
    return { accepted: false, reason: 'generation-mismatch' };
  }
  // 5. layout bucket matches
  if (target.layoutBucket !== observation.layoutBucket) {
    return { accepted: false, reason: 'bucket-mismatch' };
  }
  // 6. the fingerprint captured for this generation is still the record's fingerprint,
  //    so the measurement still describes what is rendered
  if (
    isFingerprintEmpty(target.measuredFingerprint) ||
    target.measuredFingerprint !== target.fingerprint
  ) {
    return { accepted: false, reason: 'fingerprint-mismatch' };
  }
  // 7. height is finite and non-negative
  if (!isAcceptedHeight(observation.height)) {
    return { accepted: false, reason: 'invalid-height' };
  }
  return { accepted: true };
}

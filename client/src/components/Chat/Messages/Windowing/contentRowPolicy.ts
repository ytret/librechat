/**
 * Stage 3 content-row policy: the per-kind allow-list and the content classifier.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md` §7.2, §10 step 3, §20.2.9.
 * Decisions: `ai-reports/13-stage-3-conservative-non-text-rows.md` §6 Q1 and §6 Q4.
 *
 * The policy is an **allow-list**. `CONTENT_TYPE_RULES` is exhaustive over `ContentTypes`, so
 * adding an enum member fails compilation here until it has been classified; at runtime a type
 * this build does not know about falls back to `always-mounted` rather than to windowing.
 *
 * Stage 3 rollback (§19) is a change to this table: flipping an enabled entry to
 * `always-mounted` keeps that one kind mounted without touching any other behaviour.
 *
 * This module is pure: no DOM access, no React, no module state.
 */

import { ContentTypes } from 'librechat-data-provider';
import type { ContentRowKind, ContentRowPolicy } from './contentRowTypes';
import { LARGE_ROW_HEIGHT_PX } from './contentRowTypes';

type ContentTypeRule = {
  kind: ContentRowKind;
  /** Policy for a completed source. */
  policy: ContentRowPolicy;
  /** §6 Q1 — hold an in-flight source mounted instead of letting it settle and unmount. */
  forceMountedWhileStreaming: boolean;
};

/**
 * §6 Q1 per-kind policy, keyed by the content type that produces the row. Markdown, tools,
 * parallel sections, subagents, artifacts, agent updates, and unknown media stay mounted in
 * Stage 3; only reasoning, summaries, known-size images, and a finalized error are windowable.
 */
const CONTENT_TYPE_RULES: Record<ContentTypes, ContentTypeRule> = {
  [ContentTypes.TEXT]: {
    kind: 'markdown',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.TEXT_DELTA]: {
    kind: 'markdown',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.THINK]: {
    kind: 'reasoning',
    policy: 'windowed',
    forceMountedWhileStreaming: true,
  },
  [ContentTypes.SUMMARY]: {
    kind: 'summary',
    policy: 'windowed',
    forceMountedWhileStreaming: true,
  },
  [ContentTypes.IMAGE_FILE]: {
    kind: 'image',
    policy: 'unstable-until-settled',
    /**
     * False, unlike the other asynchronous kinds. An image's in-flight state is its pending load,
     * which `unstable-until-settled` plus readiness already covers (§6 Q3); forcing it mounted
     * while "streaming" would make a loaded image permanently unmountable, contradicting the
     * explicit `unstable-until-settled` → `windowed` transition the same decision requires.
     */
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.TOOL_CALL]: {
    kind: 'tool-group',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.ERROR]: {
    kind: 'generic',
    policy: 'windowed',
    forceMountedWhileStreaming: true,
  },
  [ContentTypes.AGENT_UPDATE]: {
    kind: 'generic',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.IMAGE_URL]: {
    kind: 'generic',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.VIDEO_URL]: {
    kind: 'generic',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
  [ContentTypes.INPUT_AUDIO]: {
    kind: 'generic',
    policy: 'always-mounted',
    forceMountedWhileStreaming: false,
  },
};

/** Safe runtime fallback for a content type this build does not know (§6 Q4). */
const UNKNOWN_CONTENT_TYPE_RULE: ContentTypeRule = {
  kind: 'generic',
  policy: 'always-mounted',
  forceMountedWhileStreaming: false,
};

/** Lookup view of the exhaustive table, keyed by plain string so an unknown type is a miss. */
const RULE_BY_CONTENT_TYPE: ReadonlyMap<string, ContentTypeRule> = new Map(
  Object.entries(CONTENT_TYPE_RULES),
);

/** An image rule without stored dimensions is not the allow-listed case (§6 Q3). */
const IMAGE_WITHOUT_DIMENSIONS_RULE: ContentTypeRule = {
  ...CONTENT_TYPE_RULES[ContentTypes.IMAGE_FILE],
  policy: 'always-mounted',
};

export type ContentRowClassificationInput = {
  /** A `TMessageContentParts` type. A value outside `ContentTypes` classifies as unknown. */
  type: string;
  /** True while the source is still being written by the stream. Defaults to false. */
  streaming?: boolean;
  /** Stored dimensions of an `image_file` part. Both must be finite and positive (§6 Q3). */
  imageDimensions?: { width?: number | null; height?: number | null } | null;
};

export type ContentRowClassification = {
  /** Row the part renders in, so the call site cannot invent a kind per content type. */
  kind: ContentRowKind;
  policy: ContentRowPolicy;
  /** Pin this row while it is streaming (§6 Q1), regardless of its windowability. */
  forceMounted: boolean;
};

function isFinitePositive(value: number | null | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isKnownImageSize(dimensions: ContentRowClassificationInput['imageDimensions']): boolean {
  return isFinitePositive(dimensions?.width) && isFinitePositive(dimensions?.height);
}

function ruleFor(input: ContentRowClassificationInput): ContentTypeRule {
  if (input.type === ContentTypes.IMAGE_FILE) {
    return isKnownImageSize(input.imageDimensions)
      ? CONTENT_TYPE_RULES[ContentTypes.IMAGE_FILE]
      : IMAGE_WITHOUT_DIMENSIONS_RULE;
  }
  return RULE_BY_CONTENT_TYPE.get(input.type) ?? UNKNOWN_CONTENT_TYPE_RULE;
}

/**
 * Classify one content part into the row kind and Stage 3 policy it must be wrapped with.
 * Unlisted and unknown content classifies as `always-mounted`: nothing becomes windowable
 * by default.
 */
export function classifyContentRow(input: ContentRowClassificationInput): ContentRowClassification {
  const rule = ruleFor(input);
  return {
    kind: rule.kind,
    policy: rule.policy,
    forceMounted: rule.forceMountedWhileStreaming && input.streaming === true,
  };
}

/**
 * The kinds §6 Q1 allows to window, derived from the rule table so the two cannot drift.
 * A kind absent from this set is only ever classified `always-mounted`.
 */
export function windowableContentRowKinds(): ReadonlySet<ContentRowKind> {
  const kinds = new Set<ContentRowKind>();
  for (const rule of RULE_BY_CONTENT_TYPE.values()) {
    if (rule.policy !== 'always-mounted') {
      kinds.add(rule.kind);
    }
  }
  return kinds;
}

/** A row taller than `LARGE_ROW_HEIGHT_PX` is never windowed for that generation (§6 Q1). */
export function isOversizedRowHeight(height: number): boolean {
  return height > LARGE_ROW_HEIGHT_PX;
}

import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { VirtualizedContentRow } from './VirtualizedContentRow';
import { classifyContentRow } from './contentRowPolicy';
import { contentRowContentKey } from './contentRowContent';

/**
 * The row boundary for one message content part (spec §9.2, report 13 §6 Q1).
 *
 * Wrapping lives here rather than in `Part` so that the row sees exactly one content part, and so
 * the classifier — not each renderer — decides whether that part is windowable. A part the
 * allow-list does not cover renders as a plain block with no virtual-row attributes and no
 * registration, which is what keeps Stage 3's DOM surface unchanged for everything it does not
 * explicitly enable.
 *
 * `stateKey` is the expansion state for the kinds whose geometry changes with it: §12 requires
 * that state in the fingerprint, or a collapsed measurement would be reused for the expanded
 * source. `contentKey` is the other half of the same rule: the source key identifies *where* a part
 * sits, not *what* it contains, so without it a long error replaced by a short one at the same
 * index kept its fingerprint and its stale height (§14).
 */

export type ContentPartRowProps = {
  messageId: string;
  part: TMessageContentParts;
  /** Position of the part in the message; the row's stable source key. */
  idx: number;
  /** True while this part is still being written by the stream. */
  streaming?: boolean;
  /** Expansion state, for the kinds whose geometry depends on it. */
  stateKey?: string | number | boolean | null;
  /**
   * Suppress the row even for an allow-listed kind, for parts that live inside a container Stage 3
   * leaves mounted (a parallel section, for instance). Stage 3 does not put rows inside containers
   * whose own geometry is not proven bounded.
   */
  disabled?: boolean;
  children: React.ReactNode;
};

export function ContentPartRow({
  messageId,
  part,
  idx,
  streaming = false,
  stateKey,
  disabled = false,
  children,
}: ContentPartRowProps) {
  if (disabled) {
    return <>{children}</>;
  }
  const classification = classifyContentRow({
    type: part.type,
    streaming,
    imageDimensions: getImageDimensions(part),
  });

  if (classification.policy === 'always-mounted') {
    return <>{children}</>;
  }

  return (
    <VirtualizedContentRow
      messageId={messageId}
      kind={classification.kind}
      sourceKey={idx}
      ordinal={idx}
      stateKey={stateKey}
      /**
       * Withheld while the part is still being written. The key covers the growing text, so per
       * delta it would change the fingerprint per delta, and a fingerprint change re-keys the row
       * — a remount and a settlement attempt per token, which exhausts the attempt budget in three
       * deltas and demotes the row for good. While streaming the row is force-mounted and its
       * height comes from the resize observer, so nothing is lost by waiting; the key appears when
       * the content is final.
       */
      contentKey={streaming ? undefined : contentRowContentKey(part)}
      policy={classification.policy}
      forceMounted={classification.forceMounted}
    >
      {children}
    </VirtualizedContentRow>
  );
}

/** Stored dimensions of an `image_file` part; absent for every other kind (§6 Q3). */
function getImageDimensions(
  part: TMessageContentParts,
): { width?: number | null; height?: number | null } | null {
  if (part.type !== ContentTypes.IMAGE_FILE) {
    return null;
  }
  const imageFile = (part as { image_file?: { width?: number | null; height?: number | null } })
    .image_file;
  return imageFile ?? null;
}

export default ContentPartRow;

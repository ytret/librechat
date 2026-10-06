/**
 * Content identity for a content row (spec §12 rule 6, §14).
 *
 * The row fingerprint decides whether a previous measurement still describes what is rendered. It
 * already carried the source key and the expansion state, but not the content itself, so two
 * different contents at the same message and index produced the same fingerprint and the old height
 * stayed valid — `canRowUnmount` compares the fingerprint captured with the measurement against the
 * row's current one (§12 rule 6), and that comparison could not see the difference. A placeholder
 * left off-screen went on reserving the height of content that was no longer there.
 *
 * This is the missing input: a stable string derived from what the row actually renders, so a
 * replaced source is a new source and gets measured again.
 *
 * **Streaming is the caller's decision, not this module's.** The key is derived from the whole
 * rendered text, which grows while a part streams; supplying it per delta would change the
 * fingerprint per delta, and a fingerprint change re-keys the row (§7.5) — a remount per token, and
 * a settlement attempt charged per token, which exhausts `MAX_SETTLEMENT_ATTEMPTS` within three
 * deltas and demotes the row permanently. `ContentPartRow` therefore supplies nothing while a part
 * is streaming, where the row is force-mounted and its height is tracked by the resize observer
 * anyway, and supplies this key once the content is final.
 *
 * Pure: no DOM access, no React, no module state.
 */

import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

/**
 * A stable, order-sensitive, non-cryptographic hash. Collisions only cost a missed
 * re-measurement, never a wrong reading, so `djb2` is enough and stays cheap on long reasoning
 * bodies.
 */
function hashContent(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Join a summary part's rendered text the way `Summary` does, so the key tracks what is shown. */
function summaryText(part: TMessageContentParts): string {
  const blocks = (part as { content?: unknown }).content;
  if (!Array.isArray(blocks)) {
    return '';
  }
  return blocks
    .map((block) => {
      if (block == null || typeof block !== 'object') {
        return '';
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

function imageIdentity(part: TMessageContentParts): string {
  const file = (part as { image_file?: Record<string, unknown> }).image_file;
  if (file == null || typeof file !== 'object') {
    return '';
  }
  return [
    typeof file.filepath === 'string' ? file.filepath : '',
    typeof file.filename === 'string' ? file.filename : '',
    String(file.width ?? ''),
    String(file.height ?? ''),
  ].join('\u0001');
}

/**
 * The content a row's geometry depends on, as a string, or `undefined` for a part whose height
 * does not come from its content. `undefined` composes to no fingerprint component at all, which is
 * the pre-existing behaviour for those kinds.
 */
export function contentRowContentKey(
  part: TMessageContentParts | undefined | null,
): string | undefined {
  if (part == null) {
    return undefined;
  }
  switch (part.type) {
    case ContentTypes.THINK: {
      const think = (part as { think?: unknown }).think;
      return typeof think === 'string' ? hashContent(think) : undefined;
    }
    case ContentTypes.SUMMARY:
      return hashContent(summaryText(part));
    case ContentTypes.IMAGE_FILE:
      return hashContent(imageIdentity(part));
    case ContentTypes.ERROR: {
      const error = (part as { error?: unknown }).error;
      return typeof error === 'string' ? hashContent(error) : undefined;
    }
    default:
      return undefined;
  }
}

export default contentRowContentKey;

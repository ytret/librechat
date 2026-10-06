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
 * **Derived from the renderers, not from the shape of the part.** The first version listed the
 * fields that came to mind and missed two that the renderers draw: `Content/Part.tsx` resolves an
 * error as `part.error ?? part.text ?? part.text?.value`, so an error with no `error` field still
 * renders text, and `Parts/Summary.tsx` draws a `provider/model · N tokens` line from the part. Both
 * omissions left a stale placeholder height. Every field below is one a renderer turns into visible
 * text; adding a field to a renderer without adding it here is the way this breaks again.
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

/**
 * The `meta` line `Summary` builds: `provider/model · N tokens`.
 *
 * `tokenCount` is rendered only when it is positive, and absent and `0` produce the same line, so
 * they have to produce the same key too — otherwise a re-render would re-key the row for nothing.
 * The same applies to `provider`/`model`, which are joined and skipped when empty.
 */
function summaryMeta(part: TMessageContentParts): string {
  const fields = part as { provider?: unknown; model?: unknown; tokenCount?: unknown };
  const provider = typeof fields.provider === 'string' ? fields.provider : '';
  const model = typeof fields.model === 'string' ? fields.model : '';
  const tokenCount =
    typeof fields.tokenCount === 'number' && fields.tokenCount > 0 ? fields.tokenCount : 0;
  return [provider, model, tokenCount].map(String).join('\u0001');
}

/**
 * The text an error row renders. `Content/Part.tsx` resolves the same three fields in the same
 * order, so this mirrors the renderer rather than approximating it. `undefined` (not `''`) when
 * none of them is present: an error with no text has no content-derived height.
 */
function errorText(part: TMessageContentParts): string | undefined {
  const fields = part as { error?: unknown; text?: unknown };
  if (typeof fields.error === 'string') {
    return fields.error;
  }
  if (typeof fields.text === 'string') {
    return fields.text;
  }
  const value = (fields.text as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
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
      const fields = part as { think?: unknown; thinkDuration?: unknown };
      if (typeof fields.think !== 'string') {
        return undefined;
      }
      // The collapsed header reads "Thinking" or "Thought for N seconds", so the duration dresses
      // rendered text. Absent and `null` mean the same header, so they must mean the same key.
      const duration = fields.thinkDuration == null ? '' : String(fields.thinkDuration);
      return hashContent(`${fields.think}\u0001${duration}`);
    }
    case ContentTypes.SUMMARY: {
      const summarizing = (part as { summarizing?: unknown }).summarizing === true ? '1' : '0';
      // Body, metadata line, and the label state — everything `Summary` draws from the part.
      return hashContent(`${summaryText(part)}\u0001${summaryMeta(part)}\u0001${summarizing}`);
    }
    case ContentTypes.IMAGE_FILE:
      return hashContent(imageIdentity(part));
    case ContentTypes.ERROR: {
      const text = errorText(part);
      return text === undefined ? undefined : hashContent(text);
    }
    default:
      return undefined;
  }
}

export default contentRowContentKey;

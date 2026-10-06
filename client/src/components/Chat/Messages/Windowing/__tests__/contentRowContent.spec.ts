import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { contentRowContentKey } from '../contentRowContent';

/**
 * The row fingerprint's content component (§12 rule 6, §14). It has to change when the rendered
 * content changes — that is the whole point, since a row that keeps its fingerprint keeps its
 * measurement — and stay equal when the same content is rendered again, or every re-render would
 * re-key the row and remount its subtree.
 */

const think = (text: string) =>
  ({ type: ContentTypes.THINK, think: text }) as unknown as TMessageContentParts;
const summary = (text: string) =>
  ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text }],
  }) as unknown as TMessageContentParts;
const image = (filepath: string, width = 800, height = 600) =>
  ({
    type: ContentTypes.IMAGE_FILE,
    image_file: { filepath, filename: 'test.png', width, height },
  }) as unknown as TMessageContentParts;
const error = (message: string) =>
  ({ type: ContentTypes.ERROR, error: message }) as unknown as TMessageContentParts;

/**
 * The key is only useful if it covers every field the renderer turns into visible text. These two
 * groups exist because the first version did not: it read `part.error` only, while
 * `Content/Part.tsx` renders `part.error ?? part.text ?? part.text.value`, and it hashed a summary's
 * body only, while `Parts/Summary.tsx` also renders `provider`, `model`, and the token count.
 */
describe('contentRowContentKey covers the rendered fields', () => {
  it('follows the error fallback the renderer actually uses', () => {
    // `Part.tsx` resolves the same way, so a part with no `error` field still renders text.
    const textOnly = (text: string) =>
      ({ type: ContentTypes.ERROR, text }) as unknown as TMessageContentParts;
    expect(contentRowContentKey(textOnly('a short failure'))).not.toBe(
      contentRowContentKey(textOnly('a considerably longer failure message')),
    );

    const valueOnly = (value: string) =>
      ({ type: ContentTypes.ERROR, text: { value } }) as unknown as TMessageContentParts;
    expect(contentRowContentKey(valueOnly('a short failure'))).not.toBe(
      contentRowContentKey(valueOnly('a considerably longer failure message')),
    );

    expect(contentRowContentKey(textOnly('same'))).toBe(contentRowContentKey(textOnly('same')));
  });

  it('prefers `error` over the fallback, exactly as the renderer does', () => {
    const both = (error: string, text: string) =>
      ({ type: ContentTypes.ERROR, error, text }) as unknown as TMessageContentParts;
    // The rendered text is `error`, so a change to the shadowed fallback is not a new source.
    expect(contentRowContentKey(both('boom', 'ignored'))).toBe(
      contentRowContentKey(both('boom', 'also ignored')),
    );
    expect(contentRowContentKey(both('boom', 'ignored'))).not.toBe(
      contentRowContentKey(both('bang', 'ignored')),
    );
  });

  it('includes the summary metadata line, which the renderer draws from the part', () => {
    const meta = (fields: { provider?: string; model?: string; tokenCount?: number }) =>
      ({
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'unchanged body' }],
        ...fields,
      }) as unknown as TMessageContentParts;

    const baseline = contentRowContentKey(
      meta({ provider: 'openai', model: 'gpt-4o', tokenCount: 12 }),
    );
    expect(
      contentRowContentKey(meta({ provider: 'anthropic', model: 'gpt-4o', tokenCount: 12 })),
    ).not.toBe(baseline);
    expect(
      contentRowContentKey(meta({ provider: 'openai', model: 'gpt-4o-mini', tokenCount: 12 })),
    ).not.toBe(baseline);
    expect(
      contentRowContentKey(meta({ provider: 'openai', model: 'gpt-4o', tokenCount: 900000 })),
    ).not.toBe(baseline);
    // Same metadata and same body is the same source: a re-render must not re-key the row.
    expect(
      contentRowContentKey(meta({ provider: 'openai', model: 'gpt-4o', tokenCount: 12 })),
    ).toBe(baseline);
  });

  it('includes the summary label state and the reasoning duration label', () => {
    const summarising = (summarizing: boolean) =>
      ({
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'body' }],
        summarizing,
      }) as unknown as TMessageContentParts;
    // The collapsed header reads "Summarizing" or "Conversation summarized".
    expect(contentRowContentKey(summarising(true))).not.toBe(
      contentRowContentKey(summarising(false)),
    );

    const thought = (thinkDuration?: number) =>
      ({
        type: ContentTypes.THINK,
        think: 'body',
        thinkDuration,
      }) as unknown as TMessageContentParts;
    // The collapsed header reads "Thinking" or "Thought for N seconds".
    expect(contentRowContentKey(thought(undefined))).not.toBe(contentRowContentKey(thought(1200)));
    expect(contentRowContentKey(thought(1200))).not.toBe(contentRowContentKey(thought(4500)));
  });
});

describe('contentRowContentKey', () => {
  it('changes when a part renders different content at the same position', () => {
    expect(contentRowContentKey(think('first body'))).not.toBe(
      contentRowContentKey(think('second body')),
    );
    expect(contentRowContentKey(summary('first'))).not.toBe(
      contentRowContentKey(summary('second')),
    );
    expect(contentRowContentKey(image('/a.png'))).not.toBe(contentRowContentKey(image('/b.png')));
    expect(contentRowContentKey(image('/a.png', 800))).not.toBe(
      contentRowContentKey(image('/a.png', 400)),
    );
    expect(contentRowContentKey(error('boom'))).not.toBe(contentRowContentKey(error('bang')));
  });

  it('is equal for the same content rendered again, so a re-render is not a new source', () => {
    expect(contentRowContentKey(think('same body'))).toBe(contentRowContentKey(think('same body')));
    expect(contentRowContentKey(summary('same'))).toBe(contentRowContentKey(summary('same')));
    expect(contentRowContentKey(image('/a.png'))).toBe(contentRowContentKey(image('/a.png')));
    expect(contentRowContentKey(error('same'))).toBe(contentRowContentKey(error('same')));
  });

  it('joins a multi-block summary the way it is rendered, so a moved boundary is a change', () => {
    const oneBlock = {
      type: ContentTypes.SUMMARY,
      content: [
        { type: ContentTypes.TEXT, text: 'ab' },
        { type: ContentTypes.TEXT, text: 'c' },
      ],
    } as unknown as TMessageContentParts;
    const otherBlock = {
      type: ContentTypes.SUMMARY,
      content: [
        { type: ContentTypes.TEXT, text: 'a' },
        { type: ContentTypes.TEXT, text: 'bc' },
      ],
    } as unknown as TMessageContentParts;
    // Same rendered text, so these are deliberately equal: the key tracks what is shown.
    expect(contentRowContentKey(oneBlock)).toBe(contentRowContentKey(otherBlock));
    expect(contentRowContentKey(oneBlock)).not.toBe(
      contentRowContentKey({
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'abc ' }],
      } as unknown as TMessageContentParts),
    );
  });

  it('is undefined where a row has no content-derived geometry', () => {
    expect(contentRowContentKey(undefined)).toBeUndefined();
    expect(contentRowContentKey(null)).toBeUndefined();
    expect(
      contentRowContentKey({
        type: ContentTypes.TEXT,
        text: 'markdown is always mounted',
      } as unknown as TMessageContentParts),
    ).toBeUndefined();
    expect(
      contentRowContentKey({
        type: ContentTypes.TOOL_CALL,
      } as unknown as TMessageContentParts),
    ).toBeUndefined();
  });

  it('is undefined for a windowable kind whose content fields are absent', () => {
    expect(
      contentRowContentKey({ type: ContentTypes.THINK } as unknown as TMessageContentParts),
    ).toBeUndefined();
    expect(
      contentRowContentKey({ type: ContentTypes.ERROR } as unknown as TMessageContentParts),
    ).toBeUndefined();
  });
});

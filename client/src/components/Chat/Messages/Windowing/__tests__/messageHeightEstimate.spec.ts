import {
  DEFAULT_ASSISTANT_MESSAGE_HEIGHT,
  DEFAULT_USER_MESSAGE_HEIGHT,
  MAX_ESTIMATED_HEIGHT,
  MIN_ESTIMATED_HEIGHT,
  estimateMessageHeight,
} from '../messageHeightEstimate';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';

const message = (overrides: Partial<TMessage> = {}) =>
  ({ messageId: 'm1', conversationId: 'c1', text: '', ...overrides }) as TMessage;

describe('estimateMessageHeight', () => {
  it('uses different sensible defaults for empty user and assistant messages', () => {
    expect(estimateMessageHeight(message({ isCreatedByUser: true }))).toBeGreaterThanOrEqual(
      DEFAULT_USER_MESSAGE_HEIGHT,
    );
    expect(estimateMessageHeight(message({ isCreatedByUser: false }))).toBeGreaterThan(
      estimateMessageHeight(message({ isCreatedByUser: true })),
    );
    expect(estimateMessageHeight(message({ isCreatedByUser: false }))).toBeGreaterThanOrEqual(
      DEFAULT_ASSISTANT_MESSAGE_HEIGHT,
    );
  });

  it('increases with long text without parsing markdown', () => {
    const short = estimateMessageHeight(message({ text: 'short' }));
    const long = estimateMessageHeight(message({ text: 'x'.repeat(1800) }));
    expect(long).toBeGreaterThan(short);
  });

  it('counts structured content text', () => {
    const short = estimateMessageHeight(message({ content: [{ type: ContentTypes.TEXT, text: 'x' }] }));
    const long = estimateMessageHeight(
      message({ content: [{ type: ContentTypes.TEXT, text: { value: 'x'.repeat(1800) } }] }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it('accounts for attachments and tools and clamps the result', () => {
    const plain = estimateMessageHeight(message({ text: 'x' }));
    const attachment = estimateMessageHeight(message({ text: 'x', attachments: [{} as never] }));
    const tool = estimateMessageHeight(message({ text: 'x', tools: [{}] } as Partial<TMessage>));
    expect(attachment).toBeGreaterThan(plain);
    expect(tool).toBeGreaterThan(plain);
    expect(estimateMessageHeight(message({ text: '' }))).toBeGreaterThanOrEqual(MIN_ESTIMATED_HEIGHT);
    expect(estimateMessageHeight(message({ text: 'x'.repeat(500000) }))).toBe(MAX_ESTIMATED_HEIGHT);
  });

  it('does not mutate the message and is deterministic', () => {
    const input = message({ text: 'hello', content: [{ type: ContentTypes.TEXT, text: 'world' }] });
    const before = JSON.stringify(input);
    expect(estimateMessageHeight(input)).toBe(estimateMessageHeight(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});

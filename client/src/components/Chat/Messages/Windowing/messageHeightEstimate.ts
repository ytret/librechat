import type { TMessage } from 'librechat-data-provider';

export const DEFAULT_USER_MESSAGE_HEIGHT = 120;
export const DEFAULT_ASSISTANT_MESSAGE_HEIGHT = 420;
export const MIN_ESTIMATED_HEIGHT = 96;
export const MAX_ESTIMATED_HEIGHT = 2400;

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join(' ');
  return '';
}

export function estimateMessageHeight(message: TMessage): number {
  const text = textOf(message.text) + ' ' + textOf(message.content);
  const chrome = message.isCreatedByUser ? 80 : 140;
  let estimate = Math.max(
    message.isCreatedByUser ? DEFAULT_USER_MESSAGE_HEIGHT : DEFAULT_ASSISTANT_MESSAGE_HEIGHT,
    chrome + Math.max(1, Math.ceil(text.length / 90)) * 24,
  );
  if (message.attachments?.length) estimate += 96;
  if ('tool_call_id' in message || 'tools' in message) estimate += 64;
  return Math.max(MIN_ESTIMATED_HEIGHT, Math.min(MAX_ESTIMATED_HEIGHT, estimate));
}

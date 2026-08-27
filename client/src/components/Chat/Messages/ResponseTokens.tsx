import type { TMessage } from 'librechat-data-provider';
import { cn, readPersistedUsage } from '~/utils';
import { useLocalize } from '~/hooks';

type ResponseTokensProps = {
  message: TMessage;
  isLast: boolean;
};

/**
 * Inline completion-token count for a finished assistant response, sourced from
 * the persisted `metadata.usage.output` rollup (reasoning + visible answer
 * tokens). Hidden until hover on older messages, always visible on the latest.
 */
export default function ResponseTokens({ message, isLast }: ResponseTokensProps) {
  const localize = useLocalize();
  const output = readPersistedUsage(message)?.output;

  if (message.isCreatedByUser || output == null || output <= 0) {
    return null;
  }

  return (
    <span
      className={cn(
        'self-center text-xs tabular-nums text-text-secondary-alt',
        !isLast &&
          'group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0',
      )}
    >
      {new Intl.NumberFormat().format(output)} {localize('com_ui_tokens')}
    </span>
  );
}

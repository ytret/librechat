import type { TMessage } from 'librechat-data-provider';
import { useMessagesViewContext } from '~/Providers';

export default function useMessageProcess({ message: _message }: { message?: TMessage | null }) {
  const { conversation, isSubmitting } = useMessagesViewContext();

  return {
    isSubmitting,
    conversation,
  };
}

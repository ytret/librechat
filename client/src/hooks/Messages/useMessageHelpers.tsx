import { useCallback, useMemo } from 'react';
import { isAssistantsEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import type { TMessageProps } from '~/common';
import { useMessagesViewContext, useAssistantsMapContext, useAgentsMapContext } from '~/Providers';
import useCopyToClipboard from './useCopyToClipboard';
import { useGetAddedConvo } from '~/hooks/Chat';

export default function useMessageHelpers(props: TMessageProps) {
  const { message, currentEditId, setCurrentEditId } = props;

  const { ask, index, regenerate, isSubmitting, conversation, handleContinue, latestMessageId } =
    useMessagesViewContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();

  const getAddedConvo = useGetAddedConvo();

  const { text, content, children, messageId = null, isCreatedByUser } = message ?? {};
  const edit = messageId === currentEditId;
  const isLast = children?.length === 0 || children?.length === undefined;

  const enterEdit = useCallback(
    (cancel?: boolean) => setCurrentEditId && setCurrentEditId(cancel === true ? -1 : messageId),
    [messageId, setCurrentEditId],
  );

  const assistant = useMemo(() => {
    if (!isAssistantsEndpoint(conversation?.endpoint)) {
      return undefined;
    }

    const endpointKey = conversation?.endpoint ?? '';
    const modelKey = message?.model ?? '';

    return assistantMap?.[endpointKey] ? assistantMap[endpointKey][modelKey] : undefined;
  }, [conversation?.endpoint, message?.model, assistantMap]);

  const agent = useMemo(() => {
    if (!isAgentsEndpoint(conversation?.endpoint)) {
      return undefined;
    }

    const modelKey = message?.model ?? '';

    return agentsMap ? agentsMap[modelKey] : undefined;
  }, [agentsMap, conversation?.endpoint, message?.model]);

  const regenerateMessage = () => {
    if ((isSubmitting && isCreatedByUser === true) || !message) {
      return;
    }

    regenerate(message, { addedConvo: getAddedConvo() });
  };

  const copyToClipboard = useCopyToClipboard({ text, content });

  return {
    ask,
    edit,
    agent,
    index,
    isLast,
    assistant,
    enterEdit,
    conversation,
    isSubmitting,
    handleContinue,
    latestMessageId,
    copyToClipboard,
    regenerateMessage,
  };
}

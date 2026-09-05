import React from 'react';
import { useMessageProcess, useMemoizedChatContext } from '~/hooks';
import type { TMessageProps } from '~/common';

import MultiMessage from '~/components/Chat/Messages/MultiMessage';
import ContentRender from './ContentRender';
import { VirtualizedMessageRow } from '~/components/Chat/Messages/Windowing';

const MessageContainer = React.memo(function MessageContainer({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="text-token-text-primary w-full border-0 bg-transparent dark:border-0 dark:bg-transparent">
      {children}
    </div>
  );
});

export default function MessageContent(props: TMessageProps) {
  const { conversation, isSubmitting } = useMessageProcess({
    message: props.message,
  });
  const { message, currentEditId, setCurrentEditId } = props;
  const { chatContext, effectiveIsSubmitting } = useMemoizedChatContext(message, isSubmitting);

  if (!message || typeof message !== 'object') {
    return null;
  }

  const { children, messageId = null } = message;

  return (
    <>
      <VirtualizedMessageRow messageId={messageId ?? ''} message={message} forceMounted={effectiveIsSubmitting || currentEditId === messageId}>
        <MessageContainer>
          <div className="m-auto justify-center p-4 py-2 md:gap-6">
            <ContentRender {...props} isSubmitting={effectiveIsSubmitting} chatContext={chatContext} />
          </div>
        </MessageContainer>
      </VirtualizedMessageRow>
      <MultiMessage
        messageId={messageId}
        conversation={conversation}
        messagesTree={children ?? []}
        currentEditId={currentEditId}
        setCurrentEditId={setCurrentEditId}
      />
    </>
  );
}

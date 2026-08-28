import type { RefObject } from 'react';
import {
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  Spinner,
} from '@librechat/client';
import { useGetConversationMetadataQuery } from 'librechat-data-provider/react-query';
import type { ConversationMetadataResponse } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { formatISOLocalDateTime, cn } from '~/utils';

const EMPTY_VALUE = '—';

type Localize = ReturnType<typeof useLocalize>;

type MetadataButtonProps = {
  conversationId: string;
  showMetadataDialog?: boolean;
  setShowMetadataDialog?: (value: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement>;
};

const formatText = (value: string | null | undefined): string =>
  value && value.length > 0 ? value : EMPTY_VALUE;

const formatTimestamp = (value: string | null | undefined): string =>
  formatISOLocalDateTime(value) || EMPTY_VALUE;

function ChatMetadataDialog({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const { data, isLoading, isError } = useGetConversationMetadataQuery(conversationId);

  const rows = buildRows(data, localize);

  const renderBody = () => {
    if (isLoading) {
      return (
        <div className="flex justify-center py-8">
          <Spinner className="size-5" />
        </div>
      );
    }

    if (isError || !data) {
      return <p role="alert">{localize('com_ui_metadata_load_error')}</p>;
    }

    return (
      <dl className="divide-y divide-border-light">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-4 py-2">
            <dt className="w-32 shrink-0 text-text-secondary">{row.label}</dt>
            <dd className={cn('min-w-0 break-all text-text-primary', row.mono && 'font-mono')}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    );
  };

  return (
    <OGDialogContent
      id="chat-metadata-dialog"
      className="w-11/12 max-w-lg"
      showCloseButton={true}
      aria-describedby="chat-metadata-description"
    >
      <OGDialogHeader>
        <OGDialogTitle>{localize('com_ui_chat_metadata')}</OGDialogTitle>
      </OGDialogHeader>
      <div id="chat-metadata-description" className="text-sm text-text-secondary">
        {renderBody()}
      </div>
    </OGDialogContent>
  );
}

function buildRows(
  data: ConversationMetadataResponse | undefined,
  localize: Localize,
): Array<{ label: string; value: string; mono?: boolean }> {
  if (!data) {
    return [];
  }

  return [
    { label: localize('com_ui_metadata_title'), value: formatText(data.title) },
    {
      label: localize('com_ui_metadata_conversation_id'),
      value: formatText(data.conversationId),
      mono: true,
    },
    { label: localize('com_ui_metadata_endpoint'), value: formatText(data.endpoint) },
    { label: localize('com_ui_metadata_model'), value: formatText(data.model) },
    { label: localize('com_ui_metadata_model_label'), value: formatText(data.modelLabel) },
    {
      label: localize('com_ui_metadata_agent'),
      value: formatText(data.agentId),
      mono: true,
    },
    { label: localize('com_ui_metadata_assistant'), value: formatText(data.assistantId) },
    { label: localize('com_ui_metadata_project'), value: formatText(data.chatProjectId) },
    {
      label: localize('com_ui_metadata_created'),
      value: formatTimestamp(data.createdAt),
      mono: true,
    },
    {
      label: localize('com_ui_metadata_last_message'),
      value: formatTimestamp(data.lastMessageAt),
      mono: true,
    },
    {
      label: localize('com_ui_metadata_last_activity'),
      value: formatTimestamp(data.updatedAt),
      mono: true,
    },
    { label: localize('com_ui_metadata_message_count'), value: String(data.messageCount) },
  ];
}

export default function MetadataButton({
  conversationId,
  showMetadataDialog,
  setShowMetadataDialog,
  triggerRef,
}: MetadataButtonProps) {
  if (showMetadataDialog === undefined || setShowMetadataDialog === undefined) {
    return null;
  }

  if (!conversationId) {
    return null;
  }

  return (
    <OGDialog
      open={showMetadataDialog}
      onOpenChange={setShowMetadataDialog}
      triggerRef={triggerRef}
    >
      <ChatMetadataDialog conversationId={conversationId} />
    </OGDialog>
  );
}

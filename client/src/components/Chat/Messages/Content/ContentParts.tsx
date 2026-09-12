import { memo, useRef, useMemo, useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import type {
  TMessageContentParts,
  SearchResultData,
  TAttachment,
  Agents,
} from 'librechat-data-provider';
import type { ToolCallGroupExpansionState } from './ToolCallGroup';
import { ParallelContentRenderer, type PartWithIndex } from './ParallelContent';
import { mapAttachments, groupSequentialToolCalls } from '~/utils';
import { showThinkingAtom } from '~/store/showThinking';
import { MessageContext, SearchContext } from '~/Providers';
import { ContentPartRow } from '../Windowing/ContentPartRow';
import PendingSkillCall from './Parts/PendingSkillCall';
import { EditTextPart, EmptyText } from './Parts';
import MemoryArtifacts from './MemoryArtifacts';
import ToolCallGroup from './ToolCallGroup';
import Container from './Container';
import Part from './Part';

const getToolCallId = (part: TMessageContentParts): string =>
  (part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined)?.id ?? '';

const getToolGroupId = (parts: PartWithIndex[], fallbackScope: number): string => {
  const firstPart = parts[0];
  if (!firstPart) {
    return 'empty';
  }
  const toolCallId = getToolCallId(firstPart.part);
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  return `fallback:${fallbackScope}:${firstPart.idx}`;
};

/**
 * Stage 3 §6 Q2 — expansion state belongs to the message and the content-part index, never to
 * the row, so it outlives a row unmount. `messageId` rather than the row token is deliberate:
 * the provider must not own UI state, and a row token is replaced on remount.
 */
const expansionKeyFor = (messageId: string, idx: number): string => `${messageId}:${idx}`;

/**
 * §6 Q2 — the stable identity of one tool, so its expansion state follows the tool and not the
 * row that draws it. The tool call id is the existing stable ID used for grouping; a tool call
 * without an id falls back to the position-based key, exactly as reasoning and summary do.
 */
const toolExpansionKeyFor = (
  messageId: string,
  part: TMessageContentParts,
  idx: number,
): string => {
  const toolCallId = getToolCallId(part);
  return toolCallId ? `tool:${toolCallId}` : expansionKeyFor(messageId, idx);
};

/** Default expansion for each kind whose state is lifted; `undefined` for every other kind. */
const defaultExpansionFor = (
  part: TMessageContentParts,
  showThinkingDefault: boolean,
): boolean | undefined => {
  if (part.type === ContentTypes.THINK) {
    return showThinkingDefault;
  }
  if (part.type === ContentTypes.SUMMARY) {
    return false;
  }
  return undefined;
};

/**
 * Tool expansion is deliberately left `undefined` when the user has not touched the tool.
 * Each tool derives its own default from the auto-expand setting and its own content, which the
 * owner cannot know; see `useToolExpansion`.
 */
const isToolPart = (part: TMessageContentParts): boolean => part.type === ContentTypes.TOOL_CALL;

/**
 * True while the part is still being written by the stream (report 13 §6 Q1). Reasoning is
 * streaming until the backend stamps its duration; a summary is streaming while it reports that it
 * is summarizing. Images and errors are never streaming steps: an image's in-flight state is its
 * load, which readiness covers, and an error is already final.
 */
const isStreamingPart = (part: TMessageContentParts, isSubmitting: boolean): boolean => {
  if (!isSubmitting) {
    return false;
  }
  if (part.type === ContentTypes.THINK) {
    return part.thinkDuration == null;
  }
  if (part.type === ContentTypes.SUMMARY) {
    return part.summarizing === true;
  }
  return false;
};

/** Expansion state only changes the geometry of the kinds that have one (§12). */
const hasExpansionGeometry = (part: TMessageContentParts): boolean =>
  part.type === ContentTypes.THINK || part.type === ContentTypes.SUMMARY;

type PartWithContextProps = {
  part: TMessageContentParts;
  idx: number;
  isLastPart: boolean;
  messageId: string;
  conversationId?: string | null;
  nextType?: string;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  isCreatedByUser: boolean;
  isLast: boolean;
  partAttachments: TAttachment[] | undefined;
  hideAttachments?: boolean;
  onToolExpand?: () => void;
  /**
   * Lifted expansion state (report 13 §6 Q2). Primitives plus one referentially stable
   * dispatcher, so these props do not defeat the `memo` boundary: a stream token that leaves
   * an untouched part alone cannot re-render its historical reasoning row.
   */
  expansionKey: string;
  isExpanded?: boolean;
  onExpansionChange: (expansionKey: string, isExpanded: boolean) => void;
};

const PartWithContext = memo(function PartWithContext({
  part,
  idx,
  isLastPart,
  messageId,
  conversationId,
  nextType,
  isSubmitting,
  isLatestMessage,
  isCreatedByUser,
  isLast,
  partAttachments,
  hideAttachments,
  onToolExpand,
  expansionKey,
  isExpanded,
  onExpansionChange,
}: PartWithContextProps) {
  const contextValue = useMemo(
    () => ({
      messageId,
      isExpanded: true as const,
      conversationId,
      partIndex: idx,
      nextType,
      isSubmitting,
      isLatestMessage,
    }),
    [messageId, conversationId, idx, nextType, isSubmitting, isLatestMessage],
  );

  return (
    <MessageContext.Provider value={contextValue}>
      <Part
        part={part}
        attachments={partAttachments}
        isSubmitting={isSubmitting}
        key={`part-${messageId}-${idx}`}
        isCreatedByUser={isCreatedByUser}
        isLast={isLastPart}
        showCursor={isLastPart && isLast}
        hideAttachments={hideAttachments}
        onToolExpand={onToolExpand}
        expansionKey={expansionKey}
        isExpanded={isExpanded}
        onExpansionChange={onExpansionChange}
      />
    </MessageContext.Provider>
  );
});

type ContentPartsProps = {
  content: Array<TMessageContentParts | undefined> | undefined;
  messageId: string;
  /**
   * Skill names the user invoked manually via the `$` popover on this turn.
   * `createdHandler` seeds this on the assistant placeholder from
   * `submission.manualSkills`, and `finalHandler`'s server-backed
   * `responseMessage` replacement drops it — so the field is naturally
   * present only for the lifetime of the stream. Scalar string array (not
   * the full message object) so `React.memo` stays shallow-happy.
   */
  manualSkills?: string[];
  /** ISO timestamp of the parent message, surfaced in parallel column headers. */
  createdAt?: string | null;
  conversationId?: string | null;
  attachments?: TAttachment[];
  searchResults?: { [key: string]: SearchResultData };
  isCreatedByUser: boolean;
  isLast: boolean;
  isSubmitting: boolean;
  isLatestMessage?: boolean;
  edit?: boolean;
  enterEdit?: (cancel?: boolean) => void | null | undefined;
  siblingIdx?: number;
  setSiblingIdx?:
    | ((value: number) => void | React.Dispatch<React.SetStateAction<number>>)
    | null
    | undefined;
};

/**
 * ContentParts renders message content parts, handling both sequential and parallel layouts.
 *
 * For 90% of messages (single-agent, no parallel execution), this renders sequentially.
 * For multi-agent parallel execution, it uses ParallelContentRenderer to show columns.
 */
const ContentParts = memo(function ContentParts({
  edit,
  isLast,
  content,
  manualSkills,
  messageId,
  enterEdit,
  siblingIdx,
  attachments,
  isSubmitting,
  setSiblingIdx,
  searchResults,
  conversationId,
  isCreatedByUser,
  isLatestMessage,
  createdAt,
}: ContentPartsProps) {
  const attachmentMap = useMemo(() => mapAttachments(attachments ?? []), [attachments]);
  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;
  const showThinking = useAtomValue(showThinkingAtom);
  /**
   * Lifted expansion state for reasoning and summary parts (report 13 §6 Q2). It lives here
   * because `ContentParts` stays mounted above individual rows, so the state survives a row
   * unmount/remount — the whole point of lifting it. The windowing provider must not own it,
   * and it must not be reachable through row identity.
   */
  const [expandedParts, setExpandedParts] = useState<ReadonlyMap<string, boolean>>(
    () => new Map<string, boolean>(),
  );
  /**
   * Referentially stable on purpose. `PartWithContext` is memoized, and an inline arrow here
   * would change identity on every stream token and re-render every historical part.
   */
  const handleExpansionChange = useCallback((expansionKey: string, isExpanded: boolean) => {
    setExpandedParts((previous) => {
      if (previous.get(expansionKey) === isExpanded) {
        return previous;
      }
      const next = new Map(previous);
      next.set(expansionKey, isExpanded);
      return next;
    });
  }, []);
  const expansionPropsFor = useCallback(
    (part: TMessageContentParts, idx: number) => {
      const isTool = isToolPart(part);
      const expansionKey = isTool
        ? toolExpansionKeyFor(messageId, part, idx)
        : expansionKeyFor(messageId, idx);
      /**
       * `undefined` for a tool the user has not touched, so the tool supplies its own default
       * from the auto-expand setting and its own content; see `useToolExpansion`.
       */
      const defaultExpansion = isTool ? undefined : defaultExpansionFor(part, showThinking);
      return {
        expansionKey,
        isExpanded: expandedParts.get(expansionKey) ?? defaultExpansion,
        onExpansionChange: handleExpansionChange,
      };
    },
    [expandedParts, handleExpansionChange, messageId, showThinking],
  );
  const toolGroupExpansionRef = useRef(new Map<string, ToolCallGroupExpansionState>());
  const fallbackScopeRef = useRef({ messageId, scope: 0 });
  if (fallbackScopeRef.current.messageId !== messageId) {
    if (!effectiveIsSubmitting) {
      fallbackScopeRef.current.scope += 1;
      toolGroupExpansionRef.current.clear();
    }
    fallbackScopeRef.current.messageId = messageId;
  }
  const fallbackScope = fallbackScopeRef.current.scope;

  const handleGroupExpansionChange = useCallback(
    (groupId: string, state: ToolCallGroupExpansionState) => {
      if (!state.userOverride) {
        toolGroupExpansionRef.current.delete(groupId);
        return;
      }
      toolGroupExpansionRef.current.set(groupId, state);
    },
    [],
  );

  /**
   * Interim skill cards — rendered in a separate slot ABOVE the Parts
   * iteration based purely on the `manualSkills` message field. `content`
   * is only read to determine the "Running → Ran" visual transition
   * (`hasRealContent`), never to gate visibility, so backend deltas /
   * optimistic emissions can't race the pending cards off the screen.
   *
   * Lifecycle:
   *  - `useChatFunctions` seeds `manualSkills` on the assistant placeholder
   *    at construction → cards appear immediately on submit, with the
   *    shimmering "Running X" state (no content yet).
   *  - Through the stream, `useStepHandler` spreads the response on every
   *    update so `manualSkills` rides along; once the first real content
   *    part lands, `hasRealContent` flips true and the cards switch to
   *    the static "Ran X" state — matching what users see for
   *    model-invoked skills as they finish priming.
   *  - At finalize, `finalHandler` replaces the message with the server
   *    response (no `manualSkills` field) → interim cards disappear and
   *    the real `skill` tool_call part in `content` takes over.
   *
   * Skipped on the user side (they get `SkillPills` on the user
   * bubble) and when no skills were invoked on this turn.
   */
  const pendingSkills = useMemo(
    () => (!isCreatedByUser && manualSkills != null ? manualSkills : []),
    [isCreatedByUser, manualSkills],
  );
  const hasPendingSkills = pendingSkills.length > 0;

  /**
   * True once the assistant has started streaming something meaningful —
   * any non-text part, OR a text part with non-empty content. Drives the
   * "Running X → Ran X" transition on pending cards. An empty-text
   * placeholder (some endpoints seed one in `initialResponse.content` on
   * assistant-side) does NOT count as real content, to avoid flipping
   * the transition before the model has actually produced anything.
   */
  const hasRealContent = useMemo(
    () =>
      (content ?? []).some((part) => {
        if (part == null) {
          return false;
        }
        if (part.type !== ContentTypes.TEXT) {
          return true;
        }
        const text = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
        return text.length > 0;
      }),
    [content],
  );

  const renderPendingSkills = () =>
    pendingSkills.map((name) => (
      <PendingSkillCall key={`pending-skill-${name}`} skillName={name} loaded={hasRealContent} />
    ));

  const renderPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean) => {
      const expansionProps = expansionPropsFor(part, idx);
      return (
        <ContentPartRow
          key={`provider-${messageId}-${idx}`}
          messageId={messageId}
          part={part}
          idx={idx}
          streaming={isStreamingPart(part, effectiveIsSubmitting)}
          stateKey={hasExpansionGeometry(part) ? expansionProps.isExpanded : undefined}
          disabled={part.groupId != null}
        >
          <PartWithContext
            idx={idx}
            part={part}
            isLast={isLast}
            messageId={messageId}
            isLastPart={isLastPart}
            conversationId={conversationId}
            isLatestMessage={isLatestMessage}
            isCreatedByUser={isCreatedByUser}
            nextType={content?.[idx + 1]?.type}
            isSubmitting={effectiveIsSubmitting}
            partAttachments={attachmentMap[getToolCallId(part)]}
            {...expansionProps}
          />
        </ContentPartRow>
      );
    },
    [
      attachmentMap,
      content,
      conversationId,
      effectiveIsSubmitting,
      expansionPropsFor,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  const renderGroupedPart = useCallback(
    (part: TMessageContentParts, idx: number, isLastPart: boolean, onToolExpand?: () => void) => {
      const expansionProps = expansionPropsFor(part, idx);
      return (
        <ContentPartRow
          key={`provider-${messageId}-${idx}`}
          messageId={messageId}
          part={part}
          idx={idx}
          streaming={isStreamingPart(part, effectiveIsSubmitting)}
          stateKey={hasExpansionGeometry(part) ? expansionProps.isExpanded : undefined}
          disabled={part.groupId != null}
        >
          <PartWithContext
            idx={idx}
            part={part}
            isLast={isLast}
            messageId={messageId}
            isLastPart={isLastPart}
            conversationId={conversationId}
            isLatestMessage={isLatestMessage}
            isCreatedByUser={isCreatedByUser}
            nextType={content?.[idx + 1]?.type}
            isSubmitting={effectiveIsSubmitting}
            partAttachments={attachmentMap[getToolCallId(part)]}
            hideAttachments
            onToolExpand={onToolExpand}
            {...expansionProps}
          />
        </ContentPartRow>
      );
    },
    [
      attachmentMap,
      content,
      conversationId,
      effectiveIsSubmitting,
      expansionPropsFor,
      isCreatedByUser,
      isLast,
      isLatestMessage,
      messageId,
    ],
  );

  const sequentialParts = useMemo<PartWithIndex[]>(() => {
    if (!content) {
      return [];
    }
    const result: PartWithIndex[] = [];
    content.forEach((part, idx) => {
      if (part) {
        result.push({ part, idx });
      }
    });
    return result;
  }, [content]);

  const groupedParts = useMemo(
    () =>
      groupSequentialToolCalls(sequentialParts).map((group) => {
        if (group.type === 'single') {
          return group;
        }
        const groupId = getToolGroupId(group.parts, fallbackScope);
        const groupAttachments = group.parts.flatMap(
          ({ part }) => attachmentMap[getToolCallId(part)] ?? [],
        );
        return { ...group, groupId, groupAttachments };
      }),
    [sequentialParts, attachmentMap, fallbackScope],
  );

  // Early return: no content to render AND no pending skill cards
  if (!content && !hasPendingSkills) {
    return null;
  }

  // Edit mode: render editable text parts. Interim skill cards are a
  // mid-stream concern, not relevant in edit mode.
  if (edit === true && enterEdit && setSiblingIdx) {
    return (
      <>
        {(content ?? []).map((part, idx) => {
          if (!part) {
            return null;
          }
          const isTextPart =
            part?.type === ContentTypes.TEXT ||
            typeof (part as unknown as Agents.MessageContentText)?.text === 'string';
          const isThinkPart =
            part?.type === ContentTypes.THINK ||
            typeof (part as unknown as Agents.ReasoningDeltaUpdate)?.think === 'string';
          if (!isTextPart && !isThinkPart) {
            return null;
          }

          const isToolCall = part.type === ContentTypes.TOOL_CALL || part['tool_call_ids'] != null;
          if (isToolCall) {
            return null;
          }

          return (
            <EditTextPart
              index={idx}
              part={part as Agents.MessageContentText | Agents.ReasoningDeltaUpdate}
              messageId={messageId}
              isSubmitting={isSubmitting}
              enterEdit={enterEdit}
              siblingIdx={siblingIdx ?? null}
              setSiblingIdx={setSiblingIdx}
              key={`edit-${messageId}-${idx}`}
            />
          );
        })}
      </>
    );
  }

  const safeContent = content ?? [];
  const showEmptyCursor = safeContent.length === 0 && effectiveIsSubmitting;
  const lastContentIdx = safeContent.length - 1;

  // Parallel content: use dedicated renderer with columns (TMessageContentParts includes ContentMetadata)
  const hasParallelContent = safeContent.some((part) => part?.groupId != null);
  if (hasParallelContent) {
    return (
      <>
        {renderPendingSkills()}
        <ParallelContentRenderer
          content={content}
          messageId={messageId}
          createdAt={createdAt}
          conversationId={conversationId}
          attachments={attachments}
          searchResults={searchResults}
          isSubmitting={effectiveIsSubmitting}
          renderPart={renderPart}
        />
      </>
    );
  }

  // Sequential content: render parts in order (90% of cases)
  return (
    <SearchContext.Provider value={{ searchResults }}>
      <MemoryArtifacts attachments={attachments} />
      {renderPendingSkills()}
      {showEmptyCursor && (
        <Container>
          <EmptyText />
        </Container>
      )}
      {groupedParts.map((group) => {
        if (group.type === 'single') {
          const { part, idx } = group.part;
          return renderPart(part, idx, idx === lastContentIdx);
        }
        const { groupId } = group;
        return (
          <ToolCallGroup
            key={`tool-group-${groupId}`}
            parts={group.parts}
            isSubmitting={effectiveIsSubmitting}
            isLast={group.parts.some((p) => p.idx === lastContentIdx)}
            renderPart={renderGroupedPart}
            lastContentIdx={lastContentIdx}
            groupAttachments={group.groupAttachments}
            initialExpansionState={toolGroupExpansionRef.current.get(groupId)}
            onExpansionChange={(state) => handleGroupExpansionChange(groupId, state)}
          />
        );
      })}
    </SearchContext.Provider>
  );
});

export default ContentParts;

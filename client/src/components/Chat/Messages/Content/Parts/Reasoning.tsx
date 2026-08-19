import { memo, useMemo, useState, useEffect, useCallback, useRef, useId } from 'react';
import { useAtomValue } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import type { MouseEvent, FocusEvent } from 'react';
import { ThinkingContent, ThinkingButton, FloatingThinkingBar } from './Thinking';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { showThinkingAtom } from '~/store/showThinking';
import { useMessageContext } from '~/Providers';
import { cn, formatThinkDuration } from '~/utils';

type ReasoningProps = {
  reasoning: string;
  isLast: boolean;
  /** Backend-computed wall-clock duration (ms) once the part is finalized. */
  thinkDuration?: number;
  /** Client-side epoch (ms) marking when streaming of this part began. */
  thinkStartedAt?: number;
};

/**
 * Reasoning Component (MODERN SYSTEM)
 *
 * Used for structured content parts with ContentTypes.THINK type.
 * This handles modern message format where content is an array of typed parts.
 *
 * Pattern: `{ content: [{ type: "think", think: "<think>content</think>" }, ...] }`
 *
 * Used by:
 * - ContentParts.tsx → Part.tsx for structured messages
 * - Agent/Assistant responses (OpenAI Assistants, custom agents)
 * - O-series models (o1, o3) with reasoning capabilities
 * - Modern Claude responses with thinking blocks
 *
 * Key differences from legacy Thinking.tsx:
 * - Works with content parts array instead of plain text
 * - Strips `<think>` tags instead of `:::thinking:::` markers
 * - Each THINK part has its own independent toggle button
 * - Can be interleaved with other content types
 *
 * For legacy text-based messages, see Thinking.tsx component.
 */
const Reasoning = memo(({ reasoning, isLast, thinkDuration, thinkStartedAt }: ReasoningProps) => {
  const contentId = useId();
  const localize = useLocalize();
  const showThinking = useAtomValue(showThinkingAtom);
  const [isExpanded, setIsExpanded] = useState(showThinking);
  const [isBarVisible, setIsBarVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const { isSubmitting, isLatestMessage, nextType } = useMessageContext();

  // Strip <think> tags from the reasoning content (modern format)
  const reasoningText = useMemo(() => {
    return reasoning
      .replace(/^<think>\s*/, '')
      .replace(/\s*<\/think>$/, '')
      .trim();
  }, [reasoning]);

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleFocus = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleBlur = useCallback((e: FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsBarVisible(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (!containerRef.current?.contains(document.activeElement)) {
      setIsBarVisible(false);
    }
  }, []);

  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;

  /** The THINK part is still streaming while the whole message is being generated
   *  and the backend has not yet stamped a final `thinkDuration`. */
  const isStreaming = effectiveIsSubmitting && thinkDuration == null;

  /** Whether this is the currently-open thinking part (no later content yet). */
  const isLiveThinking = isStreaming && isLast;

  /** Live ticking only applies while this part is the open one still streaming. */
  const canTick = isLiveThinking && thinkStartedAt != null;

  /** Live ticking elapsed time (ms) since this part started. */
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (thinkStartedAt == null) {
      return;
    }
    const update = () => setElapsedMs(Math.max(0, Date.now() - thinkStartedAt));
    /** Always seed the elapsed value so a part that mounts after its own
     *  streaming window (e.g. resuming mid-text) still shows a duration. */
    update();
    if (!canTick) {
      return;
    }
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [canTick, thinkStartedAt]);

  /** The duration to display, in ms — backend value once finalized, otherwise the
   *  live ticking value while the message is still streaming. We keep showing the
   *  last ticked value once reasoning ends but text is still streaming, so the
   *  header flips to "Thought for …" immediately instead of regressing to a bare
   *  "Thoughts" until the whole response finishes. Gated on `isStreaming` so a
   *  persisted message with `thinkStartedAt` but no `thinkDuration` (a partial save
   *  from navigating away mid-thought) doesn't show a stale wall-clock duration. */
  const displayedDurationMs =
    thinkDuration ?? (isStreaming && thinkStartedAt != null ? elapsedMs : undefined);
  const formattedDuration = useMemo(
    () => (displayedDurationMs != null ? formatThinkDuration(displayedDurationMs) : null),
    [displayedDurationMs],
  );

  const label = useMemo(() => {
    if (isLiveThinking) {
      return formattedDuration
        ? localize('com_ui_thinking_duration', { duration: formattedDuration })
        : localize('com_ui_thinking');
    }
    return formattedDuration
      ? localize('com_ui_thought_duration', { duration: formattedDuration })
      : localize('com_ui_thoughts');
  }, [isLiveThinking, formattedDuration, localize]);

  if (!reasoningText) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="group/reasoning"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="group/thinking-container">
        <div className="mb-2 pb-2 pt-2">
          <ThinkingButton
            isExpanded={isExpanded}
            onClick={handleClick}
            label={label}
            content={reasoningText}
            contentId={contentId}
          />
        </div>
        <div
          id={contentId}
          role="group"
          aria-label={label}
          aria-hidden={!isExpanded || undefined}
          className={cn(nextType !== ContentTypes.THINK && isExpanded && 'mb-4')}
          style={expandStyle}
        >
          <div className="relative overflow-hidden" ref={expandRef}>
            <ThinkingContent>{reasoningText}</ThinkingContent>
            <FloatingThinkingBar
              isVisible={isBarVisible && isExpanded}
              isExpanded={isExpanded}
              onClick={handleClick}
              content={reasoningText}
              contentId={contentId}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

export default Reasoning;

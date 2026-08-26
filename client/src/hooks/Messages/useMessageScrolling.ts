import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { useState, useRef, useCallback, useEffect } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { useMessagesConversation, useMessagesSubmission } from '~/Providers';
import useScrollToRef from '~/hooks/useScrollToRef';
import { reconcileMessageContentLayout } from './messageLayout';
import store from '~/store';

const threshold = 0.85;
const debounceRate = 150;
// Distance (px) from the bottom at which auto-follow still engages — the "trigger area".
// Larger keeps the view stuck to the bottom more aggressively during streaming;
// smaller makes it easier to scroll away mid-stream.
const resizeFollowThreshold = 240;
// Expand the IntersectionObserver's bottom edge by the same amount so its notion of
// "near bottom" matches getIsNearBottom(). Without this, the zero-height messages-end
// marker only counts as visible at exactly 0px, shrinking the trigger area to nothing.
const nearBottomRootMargin = `0px 0px ${resizeFollowThreshold}px 0px`;
// A scroll-up that leaves the view within this many px of the true bottom is treated as a
// programmatic re-clamp (e.g. content shrink while pinned to the bottom) rather than a
// deliberate scroll-away, so it doesn't disengage auto-follow.
const bottomSnapEpsilon = 4;

export default function useMessageScrolling(messagesTree?: TMessage[] | null) {
  const autoScroll = useRecoilValue(store.autoScroll);

  const scrollableRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const prevScrollTopRef = useRef<number | null>(null);
  const suppressNextResizeFollowRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const { conversation, conversationId } = useMessagesConversation();
  const { setAbortScroll, isSubmitting, abortScroll } = useMessagesSubmission();

  // Read submission state at callback time so the persistent ResizeObserver never
  // acts on a stale isSubmitting/abortScroll value captured during streaming.
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;
  const abortScrollRef = useRef(abortScroll);

  // Sync abortScrollRef from Recoil state ONLY on a real state transition. The
  // scroll handler writes this ref synchronously (scroll-away -> true, scroll back
  // -> false), and that intent must win over the still-stale `abortScroll` value
  // during the render(s) it takes the state to propagate. Syncing in the render
  // body would clobber the handler's update with the stale value; a dep-guarded
  // effect only runs once the state actually commits, so it leaves the synchronous
  // intent intact in the window.
  useEffect(() => {
    abortScrollRef.current = abortScroll;
  }, [abortScroll]);

  const timeoutIdRef = useRef<NodeJS.Timeout>();

  const getIsNearBottom = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return true;
    }
    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    return distance <= resizeFollowThreshold;
  }, []);

  const debouncedSetShowScrollButton = useCallback((value: boolean) => {
    clearTimeout(timeoutIdRef.current);
    timeoutIdRef.current = setTimeout(() => {
      setShowScrollButton(value);
    }, debounceRate);
  }, []);

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        isNearBottomRef.current = entry.isIntersecting;
        debouncedSetShowScrollButton(!entry.isIntersecting);
      },
      { root: scrollableRef.current, threshold, rootMargin: nearBottomRootMargin },
    );

    observer.observe(messagesEndRef.current);

    return () => {
      observer.disconnect();
      clearTimeout(timeoutIdRef.current);
    };
  }, [messagesEndRef, scrollableRef, debouncedSetShowScrollButton]);

  const scrollCallback = () => {
    reconcileMessageContentLayout(scrollableRef.current);
    isNearBottomRef.current = true;
    debouncedSetShowScrollButton(false);
  };

  // The final backstop for "don't teleport the user": evaluated synchronously at
  // the instant the throttled scroll edge actually fires (leading or trailing),
  // after any pending timers/races. abortScrollRef is updated synchronously in the
  // scroll handler, so this reflects the user's latest scroll-away intent even
  // before the abortScroll state has propagated through Recoil.
  const shouldScroll = useCallback(() => abortScrollRef.current !== true, []);

  const { scrollToRef: scrollToBottom, handleSmoothToRef } = useScrollToRef({
    targetRef: messagesEndRef,
    callback: scrollCallback,
    smoothCallback: () => {
      scrollCallback();
      setAbortScroll(false);
    },
    shouldScroll,
  });

  const debouncedHandleScroll = useCallback(() => {
    const scrollEl = scrollableRef.current;
    const scrollTop = scrollEl?.scrollTop ?? 0;
    const prevScrollTop = prevScrollTopRef.current;
    prevScrollTopRef.current = scrollTop;
    // Positive = scrolling down, negative = scrolling up.
    const direction = prevScrollTop === null ? 0 : scrollTop - prevScrollTop;

    const distanceFromBottom = scrollEl
      ? scrollEl.scrollHeight - scrollTop - scrollEl.clientHeight
      : 0;
    isNearBottomRef.current = distanceFromBottom <= resizeFollowThreshold;

    if (isSubmittingRef.current) {
      if (direction < 0 && distanceFromBottom > bottomSnapEpsilon) {
        // The user scrolled up (even within the trigger area): disengage auto-follow and
        // drop any pending trailing scroll so it can't override the scroll-away. This
        // covers wheel, touch, scrollbar drags, keyboard, and MessageNav uniformly.
        scrollToBottom?.cancel();
        abortScrollRef.current = true;
        setAbortScroll(true);
      } else if (direction > 0 && isNearBottomRef.current) {
        // The user scrolled back down to the bottom: resume following.
        abortScrollRef.current = false;
        setAbortScroll(false);
      }
    }

    if (messagesEndRef.current && scrollableRef.current) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          isNearBottomRef.current = entry.isIntersecting;
          debouncedSetShowScrollButton(!entry.isIntersecting);
        },
        { root: scrollableRef.current, threshold, rootMargin: nearBottomRootMargin },
      );
      observer.observe(messagesEndRef.current);
      return () => observer.disconnect();
    }
  }, [debouncedSetShowScrollButton, scrollToBottom, setAbortScroll]);

  const clampScrollToContent = useCallback(() => {
    const scrollEl = scrollableRef.current;
    if (!scrollEl) {
      return false;
    }

    const maxScrollTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (scrollEl.scrollTop <= maxScrollTop) {
      return false;
    }

    scrollEl.scrollTop = maxScrollTop;
    isNearBottomRef.current = getIsNearBottom();
    return true;
  }, [getIsNearBottom]);

  const reconcileContentResize = useCallback(
    (shouldFollowResize = true) => {
      if (clampScrollToContent()) {
        return;
      }

      if (suppressNextResizeFollowRef.current) {
        suppressNextResizeFollowRef.current = false;
        isNearBottomRef.current = getIsNearBottom();
        return;
      }

      if (
        shouldFollowResize &&
        isSubmittingRef.current &&
        abortScrollRef.current !== true &&
        isNearBottomRef.current
      ) {
        scrollToBottom?.();
      }
    },
    [clampScrollToContent, getIsNearBottom, scrollToBottom],
  );

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => reconcileContentResize());
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [reconcileContentResize]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) {
      return;
    }

    const suppressNextResizeFollow = () => {
      suppressNextResizeFollowRef.current = true;
    };

    contentEl.addEventListener('pointerdown', suppressNextResizeFollow, true);
    contentEl.addEventListener('keydown', suppressNextResizeFollow, true);
    return () => {
      contentEl.removeEventListener('pointerdown', suppressNextResizeFollow, true);
      contentEl.removeEventListener('keydown', suppressNextResizeFollow, true);
    };
  }, []);

  useEffect(() => {
    if (!messagesTree || messagesTree.length === 0) {
      return;
    }

    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    // Read the synchronous ref rather than the `abortScroll` state: the state lags
    // by a render, so a token/final-swap landing in that window would otherwise be
    // able to fire a scroll after the user has already scrolled away.
    if (isSubmitting && scrollToBottom && abortScrollRef.current !== true) {
      scrollToBottom();
    }

    return () => {
      if (abortScrollRef.current === true) {
        scrollToBottom && scrollToBottom.cancel();
      }
    };
  }, [isSubmitting, messagesTree, scrollToBottom, abortScroll]);

  // Drop any pending trailing throttled scroll when generation ends. The
  // scrollToBottom throttle (145ms, leading + trailing) keeps a trailing
  // invocation alive after the last streaming token; without cancelling it, that
  // trailing edge fires a final jump to the bottom shortly after the stream
  // completes (most visible when the final message swap grows the content).
  useEffect(() => {
    if (!isSubmitting) {
      scrollToBottom?.cancel();
    }
  }, [isSubmitting, scrollToBottom]);

  useEffect(() => {
    if (!messagesEndRef.current || !scrollableRef.current) {
      return;
    }

    if (scrollToBottom && autoScroll && conversationId !== Constants.NEW_CONVO) {
      scrollToBottom();
    }
  }, [autoScroll, conversationId, scrollToBottom]);

  return {
    conversation,
    contentRef,
    scrollableRef,
    messagesEndRef,
    scrollToBottom,
    showScrollButton,
    handleSmoothToRef,
    debouncedHandleScroll,
  };
}

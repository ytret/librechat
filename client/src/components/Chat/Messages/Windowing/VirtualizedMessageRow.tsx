import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { getMessageAriaLabel } from '~/utils';
import { useLocalize } from '~/hooks';
import { estimateMessageHeight } from './messageHeightEstimate';
import { useOptionalMessageWindowing } from './MessageWindowingContext';
import { useMessagesState, useMessagesSubmission } from '~/Providers';
import type { RowToken } from './types';

export function VirtualizedMessageRow({
  messageId,
  message,
  forceMounted = false,
  ariaLabel,
  children,
}: {
  messageId: string;
  message: TMessage;
  forceMounted?: boolean;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const localize = useLocalize();
  const windowing = useOptionalMessageWindowing();
  const { registerRow, updateRowId, updateRowState, pinRow } = windowing ?? {};
  const { latestMessageId } = useMessagesState();
  const { isSubmitting } = useMessagesSubmission();
  const latestPinned = messageId === latestMessageId && isSubmitting;
  const token = useRef<RowToken>(Symbol('message-row'));
  const elementRef = useRef<HTMLDivElement>(null);
  const previousId = useRef(messageId);
  // Without a windowing provider the row must render as a plain passthrough:
  // always mounted, no height estimation, no placeholder, no registration.
  const [mounted, setMountedState] = useState(!windowing || forceMounted || latestPinned);
  const height = useRef(estimateMessageHeight(message));
  const label = ariaLabel ?? getMessageAriaLabel(message, localize);

  // The provider owns the single shared ResizeObserver. When it unmounts this row
  // it hands back the latest measured height so the placeholder preserves real
  // geometry instead of regressing to the estimate.
  const setMounted = useCallback((value: boolean, measuredHeight?: number) => {
    if (!value && typeof measuredHeight === 'number' && measuredHeight > 0) {
      height.current = measuredHeight;
    }
    setMountedState(value);
  }, []);

  useEffect(() => {
    if (!registerRow) {
      return;
    }
    const unregister = registerRow({
      token: token.current,
      id: messageId,
      message,
      element: elementRef.current,
      forceMounted: forceMounted || latestPinned,
      setMounted,
    });
    return unregister;
  }, []); // positional reconciliation is intentional; identity is mutable below
  useEffect(() => {
    if (previousId.current !== messageId) {
      updateRowId?.(token.current, previousId.current, messageId);
      previousId.current = messageId;
    }
  }, [messageId, updateRowId]);
  useEffect(() => {
    updateRowState?.(token.current, message, forceMounted || latestPinned);
    // Keep an unmounted shell in sync with content edits. Mounted rows retain
    // their measured height and let the provider ResizeObserver supply the
    // authoritative value at unmount time.
    if (!mounted) height.current = estimateMessageHeight(message);
  }, [message, forceMounted, latestPinned, mounted, updateRowState]);
  useEffect(() => {
    const node = elementRef.current;
    if (!node || !pinRow) return;
    let interactionRelease: (() => void) | undefined;
    let focusRelease: (() => void) | undefined;
    let interactionTimer: ReturnType<typeof setTimeout> | undefined;
    const down = () => {
      interactionRelease?.();
      interactionRelease = pinRow(token.current, 'interaction');
      if (interactionTimer) clearTimeout(interactionTimer);
      interactionTimer = setTimeout(() => {
        interactionRelease?.();
        interactionRelease = undefined;
      }, 1500);
    };
    const focus = () => {
      focusRelease?.();
      focusRelease = pinRow(token.current, 'focus');
    };
    const blur = () =>
      setTimeout(() => {
        if (!node.contains(document.activeElement)) {
          focusRelease?.();
          focusRelease = undefined;
        }
      }, 0);
    node.addEventListener('pointerdown', down);
    node.addEventListener('focusin', focus);
    node.addEventListener('focusout', blur);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('focusin', focus);
      node.removeEventListener('focusout', blur);
      if (interactionTimer) clearTimeout(interactionTimer);
      interactionRelease?.();
      focusRelease?.();
    };
  }, [pinRow]);

  return (
    <div
      ref={elementRef}
      id={messageId}
      aria-label={label}
      tabIndex={-1}
      className="message-render"
      data-message-virtual-row="true"
      data-message-mounted={mounted ? 'true' : 'false'}
      style={mounted ? undefined : { height: `${height.current}px`, overflowAnchor: 'none' }}
    >
      {mounted ? children : null}
    </div>
  );
}
export default VirtualizedMessageRow;

import React, { useEffect, useRef, useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { getMessageAriaLabel } from '~/utils';
import { useLocalize } from '~/hooks';
import { estimateMessageHeight } from './messageHeightEstimate';
import { useMessageWindowing } from './MessageWindowingContext';
import type { PinReason, RowToken } from './types';

export function VirtualizedMessageRow({ messageId, message, forceMounted = false, ariaLabel, children }: { messageId: string; message: TMessage; forceMounted?: boolean; ariaLabel?: string; children: React.ReactNode }) {
  const localize = useLocalize();
  const { registerRow, updateRowId, reportHeight, pinRow } = useMessageWindowing();
  const token = useRef<RowToken>(Symbol('message-row'));
  const elementRef = useRef<HTMLDivElement>(null);
  const previousId = useRef(messageId);
  const [mounted, setMounted] = useState(true);
  const height = useRef(estimateMessageHeight(message));
  const label = ariaLabel ?? getMessageAriaLabel(message, localize);

  useEffect(() => {
    const unregister = registerRow({ token: token.current, id: messageId, message, element: elementRef.current, forceMounted, setMounted });
    return unregister;
  }, []); // positional reconciliation is intentional; identity is mutable below
  useEffect(() => { if (previousId.current !== messageId) { updateRowId(token.current, previousId.current, messageId); previousId.current = messageId; } }, [messageId, updateRowId]);
  useEffect(() => { if (forceMounted) setMounted(true); }, [forceMounted]);
  useEffect(() => { const node = elementRef.current; if (!node || typeof ResizeObserver === 'undefined') return; const observer = new ResizeObserver(([entry]) => { const value = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height; if (value > 0) { height.current = value; reportHeight(token.current, value); } }); observer.observe(node); return () => observer.disconnect(); }, [reportHeight]);
  useEffect(() => { const node = elementRef.current; if (!node) return; const pin = (reason: PinReason) => pinRow(token.current, reason); const down = () => pin('interaction'); const focus = () => pin('focus'); node.addEventListener('pointerdown', down); node.addEventListener('focusin', focus); return () => { node.removeEventListener('pointerdown', down); node.removeEventListener('focusin', focus); }; }, [pinRow]);

  return <div ref={elementRef} id={messageId} aria-label={label} tabIndex={-1} className="message-render" data-message-virtual-row="true" data-message-mounted={mounted ? 'true' : 'false'} style={mounted ? undefined : { height: `${height.current}px`, overflowAnchor: 'none' }}>{mounted ? children : null}</div>;
}
export default VirtualizedMessageRow;

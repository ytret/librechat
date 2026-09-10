import React from 'react';
import type { TMessage } from 'librechat-data-provider';
import { getMessageAriaLabel } from '~/utils';
import { useLocalize } from '~/hooks';

/**
 * Non-windowing message identity shell.
 *
 * Stage 1 replacement for `VirtualizedMessageRow`: it preserves the stable
 * `.message-render` identity (`id`, `aria-label`, `tabIndex`) for every active
 * message and always renders its children. It performs no height estimation,
 * owns no placeholder state, registers no intersection target, and never
 * conditionally renders (or unmounts) its children.
 *
 * Recursive `<MultiMessage>` placement stays outside this shell. Content-row
 * windowing (Stage 2+) mounts its rows inside these children.
 */
export function MessageShell({
  messageId,
  message,
  ariaLabel,
  children,
}: {
  messageId: string;
  message: TMessage;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const localize = useLocalize();
  const label = ariaLabel ?? getMessageAriaLabel(message, localize);

  return (
    <div id={messageId} aria-label={label} tabIndex={-1} className="message-render">
      {children}
    </div>
  );
}

export default MessageShell;

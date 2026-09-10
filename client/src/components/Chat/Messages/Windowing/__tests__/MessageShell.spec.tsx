import React from 'react';
import { render, screen } from '@testing-library/react';
import { MessageShell } from '../MessageShell';
import type { TMessage } from 'librechat-data-provider';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/utils', () => ({
  getMessageAriaLabel: () => 'message label',
}));

const message = (id: string, text = id) =>
  ({
    messageId: id,
    conversationId: 'conversation',
    text,
    isCreatedByUser: false,
  }) as TMessage;

describe('MessageShell', () => {
  it('renders one .message-render identity shell with id, aria-label and tabIndex', () => {
    render(
      <MessageShell messageId="message-1" message={message('message-1')}>
        <div data-testid="content">body</div>
      </MessageShell>,
    );
    const shell = document.getElementById('message-1');
    expect(shell).toHaveClass('message-render');
    expect(shell).toHaveAttribute('aria-label', 'message label');
    expect(shell).toHaveAttribute('tabindex', '-1');
    expect(document.querySelectorAll('.message-render')).toHaveLength(1);
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('always renders its children and adds no windowing attributes', () => {
    render(
      <MessageShell messageId="message-1" message={message('message-1')}>
        <div data-testid="content">body</div>
      </MessageShell>,
    );
    const shell = document.getElementById('message-1')!;
    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(shell).not.toHaveAttribute('data-message-virtual-row');
    expect(shell).not.toHaveAttribute('data-message-mounted');
    expect(shell.style.height).toBe('');
  });

  it('preserves the rendered subtree when the message ID changes', () => {
    const { rerender } = render(
      <MessageShell messageId="client-id" message={message('client-id')}>
        <div data-testid="content">body</div>
      </MessageShell>,
    );
    const content = screen.getByTestId('content');
    rerender(
      <MessageShell messageId="server-id" message={message('server-id')}>
        <div data-testid="content">body</div>
      </MessageShell>,
    );
    expect(document.getElementById('client-id')).toBeNull();
    expect(document.getElementById('server-id')).toBeInTheDocument();
    expect(screen.getByTestId('content')).toBe(content);
  });

  it('honors an explicit ariaLabel override', () => {
    render(
      <MessageShell messageId="message-1" message={message('message-1')} ariaLabel="custom label">
        <div>body</div>
      </MessageShell>,
    );
    expect(document.getElementById('message-1')).toHaveAttribute('aria-label', 'custom label');
  });
});

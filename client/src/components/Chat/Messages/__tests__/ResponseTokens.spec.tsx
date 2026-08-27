import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import ResponseTokens from '../ResponseTokens';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const assistantMessage = {
  messageId: 'assistant-1',
  isCreatedByUser: false,
} as TMessage;

const withOutput = (output: number): TMessage =>
  ({
    ...assistantMessage,
    metadata: { usage: { input: 150, output, cacheWrite: 0, cacheRead: 0 } },
  }) as TMessage;

describe('ResponseTokens', () => {
  it('renders the completion-token count for a finished assistant response', () => {
    render(<ResponseTokens message={withOutput(1234)} isLast={true} />);
    expect(screen.getByText(/1,234/)).toBeInTheDocument();
  });

  it('hides the count for user messages', () => {
    const message = { ...withOutput(1234), isCreatedByUser: true };
    const { container } = render(<ResponseTokens message={message} isLast={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the count when no output tokens were recorded', () => {
    const { container } = render(<ResponseTokens message={assistantMessage} isLast={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reveals the count only on hover for non-latest messages', () => {
    render(<ResponseTokens message={withOutput(250)} isLast={false} />);
    expect(screen.getByText(/250/).className).toContain('group-hover:opacity-100');
  });

  it('keeps the count visible without hover for the latest message', () => {
    render(<ResponseTokens message={withOutput(250)} isLast={true} />);
    expect(screen.getByText(/250/).className).not.toContain('group-hover:opacity-100');
  });
});

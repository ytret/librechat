import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MessageWindowingProvider } from '../MessageWindowingContext';
import { VirtualizedMessageRow } from '../VirtualizedMessageRow';
import type { TMessage } from 'librechat-data-provider';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/utils', () => ({
  getMessageAriaLabel: () => 'message label',
}));
jest.mock('~/Providers', () => ({
  useMessagesState: () => ({ latestMessageId: null }),
  useMessagesSubmission: () => ({ isSubmitting: false }),
}));

const message = (id: string, text = id) => ({
  messageId: id,
  conversationId: 'conversation',
  text,
  isCreatedByUser: false,
}) as TMessage;

class MockIntersectionObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: IntersectionObserverCallback) {}
}
class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: ResizeObserverCallback) {}
}

const originalIO = global.IntersectionObserver;
const originalRO = global.ResizeObserver;
const originalRAF = global.requestAnimationFrame;

function renderRow(forceMounted = true, id = 'message-1') {
  const scrollableRef = React.createRef<HTMLDivElement>();
  const view = render(
    <MessageWindowingProvider scrollableRef={scrollableRef} conversationId="conversation">
      <div ref={scrollableRef} className="scrollbar-gutter-stable">
        <VirtualizedMessageRow messageId={id} message={message(id)} forceMounted={forceMounted}>
          <div data-testid="expensive-content">expensive message body</div>
        </VirtualizedMessageRow>
      </div>
    </MessageWindowingProvider>,
  );
  return { ...view, scrollableRef };
}

describe('VirtualizedMessageRow', () => {
  beforeEach(() => {
    global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
  });
  afterEach(() => {
    global.IntersectionObserver = originalIO;
    global.ResizeObserver = originalRO;
    global.requestAnimationFrame = originalRAF;
  });

  it('keeps the public shell identity on the wrapper and renders content when mounted', () => {
    renderRow(true);
    const shell = document.getElementById('message-1');
    expect(shell).toHaveClass('message-render');
    expect(shell).toHaveAttribute('data-message-virtual-row', 'true');
    expect(shell).toHaveAttribute('data-message-mounted', 'true');
    expect(shell).toHaveAttribute('aria-label', 'message label');
    expect(shell).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('expensive-content')).toBeInTheDocument();
  });

  it('renders a height-preserving shell without expensive descendants when unmounted', () => {
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.id === 'message-1'
        ? ({ top: 5000, bottom: 5100, left: 0, right: 100, width: 100, height: 100 } as DOMRect)
        : ({ top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 } as DOMRect);
    });
    renderRow(false);
    const shell = document.getElementById('message-1');
    expect(shell).toHaveClass('message-render');
    expect(shell).toHaveAttribute('data-message-mounted', 'false');
    expect(shell).not.toContainElement(screen.queryByTestId('expensive-content'));
    expect(shell?.style.height).toMatch(/px$/);
    expect(shell?.style.overflowAnchor).toBe('none');
    rectSpy.mockRestore();
  });

  it('updates the public ID without replacing the row subtree', () => {
    const scrollableRef = React.createRef<HTMLDivElement>();
    const view = render(
      <MessageWindowingProvider scrollableRef={scrollableRef} conversationId="conversation">
        <div ref={scrollableRef} className="scrollbar-gutter-stable">
          <VirtualizedMessageRow messageId="client-id" message={message('client-id')} forceMounted>
            <div data-testid="stable-content">stable content</div>
          </VirtualizedMessageRow>
        </div>
      </MessageWindowingProvider>,
    );
    const content = screen.getByTestId('stable-content');
    view.rerender(
      <MessageWindowingProvider scrollableRef={scrollableRef} conversationId="conversation">
        <div ref={scrollableRef} className="scrollbar-gutter-stable">
          <VirtualizedMessageRow messageId="server-id" message={message('server-id')} forceMounted>
            <div data-testid="stable-content">stable content</div>
          </VirtualizedMessageRow>
        </div>
      </MessageWindowingProvider>,
    );
    expect(document.getElementById('client-id')).toBeNull();
    expect(document.getElementById('server-id')).toBeInTheDocument();
    expect(screen.getByTestId('stable-content')).toBe(content);
  });

  it('pins a mounted row briefly when it receives pointer interaction', () => {
    jest.useFakeTimers();
    const { scrollableRef } = renderRow(false);
    const shell = document.getElementById('message-1')!;
    act(() => fireEvent.pointerDown(shell));
    expect(shell).toHaveAttribute('data-message-mounted', 'true');
    act(() => jest.advanceTimersByTime(1600));
    // The row is eligible for reevaluation after the grace period; it remains a
    // valid shell even when the provider has no geometry requiring unmounting.
    expect(shell).toHaveClass('message-render');
    jest.useRealTimers();
  });
});

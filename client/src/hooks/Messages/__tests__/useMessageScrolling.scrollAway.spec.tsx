import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import {
  MessagesViewContext,
  type MessagesViewContextValue,
} from '~/Providers/MessagesViewContext';

jest.mock('../messageLayout', () => ({
  reconcileMessageContentLayout: jest.fn(),
}));

import useMessageScrolling from '../useMessageScrolling';

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  static reset() {
    MockResizeObserver.instances = [];
  }
  static last(): MockResizeObserver | undefined {
    return MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  }
  readonly callback: ResizeObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static reset() {
    MockIntersectionObserver.instances = [];
  }
  readonly callback: IntersectionObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  takeRecords = jest.fn(() => []);
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
}

const originalResizeObserver = global.ResizeObserver;
const originalIntersectionObserver = global.IntersectionObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'openAI',
  model: 'gpt-4',
} as TConversation;

const message = {
  messageId: 'message-1',
  conversationId: conversation.conversationId,
  isCreatedByUser: false,
} as TMessage;

function createContextValue(
  overrides: Partial<MessagesViewContextValue> = {},
): MessagesViewContextValue {
  return {
    conversation,
    conversationId: conversation.conversationId,
    isSubmitting: true,
    abortScroll: false,
    setAbortScroll: jest.fn(),
    ask: jest.fn(),
    regenerate: jest.fn(),
    handleContinue: jest.fn(),
    index: 0,
    latestMessageId: message.messageId,
    latestMessageDepth: 0,
    getMessages: jest.fn(),
    setMessages: jest.fn(),
    ...overrides,
  } as MessagesViewContextValue;
}

function ScrollingHarness({ messagesTree }: { messagesTree?: TMessage[] | null }) {
  const { contentRef, scrollableRef, messagesEndRef, debouncedHandleScroll } =
    useMessageScrolling(messagesTree);

  return (
    <div ref={scrollableRef} onScroll={debouncedHandleScroll} data-testid="scrollable">
      <div ref={contentRef} data-testid="content">
        <div ref={messagesEndRef} data-testid="end" />
      </div>
    </div>
  );
}

function renderScrolling({
  contextOverrides,
  messagesTree,
}: {
  contextOverrides?: Partial<MessagesViewContextValue>;
  messagesTree?: TMessage[] | null;
} = {}) {
  return render(
    <RecoilRoot>
      <MessagesViewContext.Provider value={createContextValue(contextOverrides)}>
        <ScrollingHarness messagesTree={messagesTree} />
      </MessagesViewContext.Provider>
    </RecoilRoot>,
  );
}

describe('useMessageScrolling scroll-away backstop (real throttle)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockResizeObserver.reset();
    MockIntersectionObserver.reset();
    (global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
      MockResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
    ).IntersectionObserver = MockIntersectionObserver;
    Element.prototype.scrollIntoView = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    (global as unknown as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      originalResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof IntersectionObserver | undefined }
    ).IntersectionObserver = originalIntersectionObserver;
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('does not scroll on a tree change in the propagation window after the user scrolls away', () => {
    const setAbortScroll = jest.fn();
    const { rerender } = renderScrolling({
      contextOverrides: { isSubmitting: true, abortScroll: false, setAbortScroll },
      messagesTree: [message],
    });

    const scrollIntoView = Element.prototype.scrollIntoView as jest.Mock;
    // Mount effect fires one leading scroll-to-bottom (synchronously).
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // User scrolls up. This synchronously marks the ref as aborted and cancels the
    // mount's pending trailing edge, but (in this harness) the Recoil `abortScroll`
    // state is not actually updated — mimicking the propagation window before the
    // state re-render commits.
    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 800;
    fireEvent.scroll(scrollable); // establish previous position (bottom)
    scrollable.scrollTop = 600; // scroll up
    fireEvent.scroll(scrollable);

    expect(setAbortScroll).toHaveBeenCalledWith(true);
    scrollIntoView.mockClear();

    // A streaming token / final swap lands before the abortScroll state has
    // propagated — the context still reports abortScroll=false.
    rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider
          value={createContextValue({ isSubmitting: true, abortScroll: false, setAbortScroll })}
        >
          <ScrollingHarness messagesTree={[message, { ...message, messageId: 'message-2' }]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    // Neither the effect nor any still-pending throttled edge may teleport the view.
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('still follows tree changes while the user is pinned to the bottom', () => {
    const { rerender } = renderScrolling({
      contextOverrides: { isSubmitting: true, abortScroll: false },
      messagesTree: [message],
    });

    const scrollIntoView = Element.prototype.scrollIntoView as jest.Mock;
    // Flush the mount's trailing edge so the throttle opens a fresh window.
    act(() => {
      jest.advanceTimersByTime(200);
    });
    scrollIntoView.mockClear();

    rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: true })}>
          <ScrollingHarness messagesTree={[message, { ...message, messageId: 'message-2' }]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(scrollIntoView).toHaveBeenCalled();
  });
});

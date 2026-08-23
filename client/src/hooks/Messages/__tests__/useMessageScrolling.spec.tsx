import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import {
  MessagesViewContext,
  type MessagesViewContextValue,
} from '~/Providers/MessagesViewContext';

type MockScrollToBottom = jest.Mock & {
  cancel: jest.Mock;
  flush: jest.Mock;
};

const mockScrollToBottom = jest.fn() as MockScrollToBottom;
mockScrollToBottom.cancel = jest.fn();
mockScrollToBottom.flush = jest.fn();
const mockHandleSmoothToRef = jest.fn();
let mockScrollCallback: (() => void) | undefined;

jest.mock('~/hooks/useScrollToRef', () => ({
  __esModule: true,
  default: ({ callback }: { callback: () => void }) => {
    mockScrollCallback = callback;
    return {
      scrollToRef: mockScrollToBottom,
      handleSmoothToRef: mockHandleSmoothToRef,
    };
  },
}));

jest.mock('../messageLayout', () => ({
  reconcileMessageContentLayout: jest.fn(),
}));

import useMessageScrolling from '../useMessageScrolling';
import { reconcileMessageContentLayout } from '../messageLayout';

const mockReconcileMessageContentLayout = reconcileMessageContentLayout as jest.Mock;

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

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  element.getBoundingClientRect = jest.fn(
    () =>
      ({
        x: rect.x ?? 0,
        y: rect.y ?? 0,
        top: rect.top ?? 0,
        left: rect.left ?? 0,
        right: rect.right ?? 0,
        bottom: rect.bottom ?? 0,
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

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

describe('useMessageScrolling resize reconciliation', () => {
  beforeEach(() => {
    MockResizeObserver.reset();
    MockIntersectionObserver.reset();
    mockScrollToBottom.mockClear();
    mockScrollToBottom.cancel.mockClear();
    mockScrollToBottom.flush.mockClear();
    mockHandleSmoothToRef.mockClear();
    mockReconcileMessageContentLayout.mockClear();
    mockScrollCallback = undefined;
    (global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
      MockResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
    ).IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    (global as unknown as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      originalResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof IntersectionObserver | undefined }
    ).IntersectionObserver = originalIntersectionObserver;
  });

  it('scrolls to the bottom when streaming content resizes and auto-scroll is active', () => {
    renderScrolling();

    const observer = MockResizeObserver.last();
    expect(observer?.observe).toHaveBeenCalledWith(screen.getByTestId('content'));

    act(() => {
      observer?.trigger();
    });

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('reconciles message layout after an explicit scroll to bottom', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    act(() => {
      mockScrollCallback?.();
    });

    expect(mockReconcileMessageContentLayout).toHaveBeenCalledWith(scrollable);
  });

  it('does not follow resizes after the user aborts streaming auto-scroll', () => {
    renderScrolling({ contextOverrides: { abortScroll: true } });

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('does not follow resizes after the user scrolls away from the bottom', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 100;

    fireEvent.scroll(scrollable);

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('still follows resizes while within the near-bottom trigger area', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    // distance from bottom = 1000 - 600 - 200 = 200px: beyond the old 120px trigger
    // area but inside the enlarged one, so follow must still engage.
    scrollable.scrollTop = 600;

    fireEvent.scroll(scrollable);

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(mockScrollToBottom).toHaveBeenCalled();
  });

  it('does not follow the next resize after user interaction inside message content', () => {
    renderScrolling();

    fireEvent.pointerDown(screen.getByTestId('content'));

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('clamps the scroll position back to content after a resize shrink', () => {
    renderScrolling({ contextOverrides: { abortScroll: true } });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 450;

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(300);
    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('does not clamp to rendered content bottom during general resize reconciliation', () => {
    renderScrolling({ contextOverrides: { abortScroll: true } });

    const scrollable = screen.getByTestId('scrollable');
    const content = screen.getByTestId('content');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 700;
    setRect(scrollable, { top: 0, bottom: 200, height: 200 });
    setRect(content, { top: -700, bottom: -200, height: 500 });

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(700);
    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('follows message tree changes while streaming', () => {
    const { rerender } = renderScrolling({
      contextOverrides: { isSubmitting: true },
      messagesTree: [message],
    });

    // The mount effect follows the initial tree; clear it so we only assert on the
    // post-update re-render.
    mockScrollToBottom.mockClear();

    // A new streaming token produces a new tree; the view should follow it to the bottom.
    rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: true })}>
          <ScrollingHarness
            messagesTree={[...[message], { ...message, messageId: 'message-2' }]}
          />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(mockScrollToBottom).toHaveBeenCalled();
  });

  it('does not follow message tree changes when auto-scroll is aborted', () => {
    const { rerender } = renderScrolling({
      contextOverrides: { isSubmitting: true, abortScroll: true },
      messagesTree: [message],
    });

    mockScrollToBottom.mockClear();

    rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider
          value={createContextValue({ isSubmitting: true, abortScroll: true })}
        >
          <ScrollingHarness
            messagesTree={[...[message], { ...message, messageId: 'message-2' }]}
          />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('marks auto-scroll as aborted when the user scrolls up, even within the trigger area', () => {
    const setAbortScroll = jest.fn();
    renderScrolling({
      contextOverrides: { isSubmitting: true, setAbortScroll },
      messagesTree: [message],
    });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 800; // at the bottom
    fireEvent.scroll(scrollable); // establish the previous scroll position

    scrollable.scrollTop = 600; // distance 200px: still within the trigger area
    fireEvent.scroll(scrollable); // scrolling up must disengage

    expect(setAbortScroll).toHaveBeenCalledWith(true);
  });

  it('resumes auto-follow when the user scrolls down to the bottom', () => {
    const setAbortScroll = jest.fn();
    renderScrolling({
      contextOverrides: { isSubmitting: true, abortScroll: true, setAbortScroll },
      messagesTree: [message],
    });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 300; // far from the bottom
    fireEvent.scroll(scrollable); // establish the previous scroll position

    scrollable.scrollTop = 800; // back to the bottom
    fireEvent.scroll(scrollable); // scrolling down must resume following

    expect(setAbortScroll).toHaveBeenCalledWith(false);
  });

  it('does not abort when the view is re-clamped to the bottom while pinned', () => {
    const setAbortScroll = jest.fn();
    renderScrolling({
      contextOverrides: { isSubmitting: true, setAbortScroll },
      messagesTree: [message],
    });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 800; // pinned to the bottom
    fireEvent.scroll(scrollable);

    // A tiny upward shift (e.g. content shrink re-clamping the view) stays within the
    // snap epsilon, so it must not be mistaken for a deliberate scroll-away.
    scrollable.scrollTop = 798;
    fireEvent.scroll(scrollable);

    expect(setAbortScroll).not.toHaveBeenCalled();
  });

  it('cancels any pending trailing scroll when generation completes', () => {
    const { rerender } = renderScrolling({ contextOverrides: { isSubmitting: true } });

    mockScrollToBottom.cancel.mockClear();

    rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: false })}>
          <ScrollingHarness />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(mockScrollToBottom.cancel).toHaveBeenCalled();
  });

  it('does not follow resizes after generation completes even if content still resizes', () => {
    const { rerender } = renderScrolling({ contextOverrides: { isSubmitting: true } });

    const observer = MockResizeObserver.last();
    act(() => {
      observer?.trigger();
    });
    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);

    rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: false })}>
          <ScrollingHarness />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    act(() => {
      observer?.trigger();
    });

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });
});

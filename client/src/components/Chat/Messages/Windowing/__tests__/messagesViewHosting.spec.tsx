import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, waitFor } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';
import MessagesView from '../../MessagesView';

/**
 * Stage 3 task 3.7 — `MessagesView` really hosts the provider (report 13 §6 Q6).
 *
 * `chatTreeWindowing.spec.tsx` tests the host's behaviour; this file tests the wiring, because
 * deleting the host from `MessagesView` left the rest of the suite green. `useMessageScrolling` is
 * mocked to supply the three refs the host needs, and `MultiMessage` is mocked to emit the message
 * content the rows wrap — everything between them is the real chat tree.
 */

const originalRAF = global.requestAnimationFrame;
const originalCAF = global.cancelAnimationFrame;
const originalIO = global.IntersectionObserver;
const originalRO = global.ResizeObserver;

let frameQueue: FrameRequestCallback[] = [];

const flushFrames = (count = 1) => {
  for (let index = 0; index < count; index++) {
    const queue = frameQueue;
    frameQueue = [];
    queue.forEach((callback) => callback(0));
  }
};

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  takeRecords = jest.fn(() => []);
  root = null;
  rootMargin = '0px';
  thresholds = [0];
  constructor(public callback: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this);
  }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
}

beforeEach(() => {
  frameQueue = [];
  api = null;
  MockIntersectionObserver.instances = [];
  MockResizeObserver.instances = [];
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  resetContentRowWindowingEnabledForTests();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).__lcContentRows;
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useScreenshot: () => ({ screenshotTargetRef: { current: null } }),
  useMessageScrolling: () => ({
    conversation: { conversationId: 'conversation-1' },
    contentRef: { current: null },
    scrollableRef: { current: null },
    messagesEndRef: { current: null },
    pinnedToBottomRef: { current: false },
    showScrollButton: false,
    handleSmoothToRef: { current: null },
    debouncedHandleScroll: jest.fn(),
  }),
}));

jest.mock('~/Providers', () => ({
  MessagesViewProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../../MultiMessage', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { ContentPartRow } =
    jest.requireActual<typeof import('../ContentPartRow')>('../ContentPartRow');
  const { useOptionalContentRowWindowing } = jest.requireActual<
    typeof import('../ContentRowWindowingContext')
  >('../ContentRowWindowingContext');
  // Required inside the factory: a mock factory may not close over module scope.
  const { ContentTypes: MockContentTypes } =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  /** A component, so the hook call is legal where the mock is defined. */
  const Probe = () => {
    api = useOptionalContentRowWindowing();
    return null;
  };
  return {
    __esModule: true,
    default: () =>
      React.createElement(
        'div',
        { className: 'message-render', id: 'm1' },
        React.createElement(Probe),
        React.createElement(
          ContentPartRow as React.ComponentType<Record<string, unknown>>,
          {
            messageId: 'm1',
            idx: 0,
            part: {
              type: MockContentTypes.THINK,
              think: 'a reasoning body',
              thinkDuration: 1200,
            },
          },
          React.createElement('div', { 'data-testid': 'reasoning-body' }, 'a reasoning body'),
        ),
      ),
  };
});

jest.mock('../../MessageNav', () => ({ __esModule: true, default: () => null }));

jest.mock('~/components/Messages/ScrollToBottom', () => ({
  __esModule: true,
  default: () => null,
}));

let api: ContentRowWindowingRuntime | null;

/** A non-empty tree: `MessagesView` renders the "nothing found" placeholder for an empty one. */
const renderView = () => {
  const result = render(
    <RecoilRoot>
      <MessagesView
        messagesTree={[{ messageId: 'm1', conversationId: 'conversation-1', text: '' } as TMessage]}
      />
    </RecoilRoot>,
  );
  flushFrames(4);
  return result;
};

const rowShells = () => document.querySelectorAll('[data-content-virtual-row="true"]').length;

describe('MessagesView hosting', () => {
  it('hosts the provider, so an approved part registers as a row while the flag is on', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderView();

    expect(api).not.toBeNull();
    expect(rowShells()).toBe(1);
    expect(api?.getDiagnostics().registeredRows).toBe(1);
  });

  it('hosts nothing while the flag is off', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    renderView();

    expect(api).toBeNull();
    expect(rowShells()).toBe(0);
    expect(document.querySelector('[data-testid="reasoning-body"]')).not.toBeNull();
  });

  it('installs no observers while the flag is off', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    renderView();

    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(MockResizeObserver.instances).toHaveLength(0);
  });

  /**
   * Report 13 §14.5: the hard-fling coverage bar is measured from this page, through the chat
   * handle rather than the fixture's. `MessagesView` assigns its own scroll container to
   * `scrollableRef` through the ref callback, so the sampler starting successfully here also
   * proves it was handed the chat's pane: a null root would answer "no scroll pane". The module is
   * imported lazily, so the first calls answer with the loading stub instead.
   */
  it('exposes the per-frame visibility sampler on the chat handle, over the chat pane', async () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderView();

    expect(typeof window.__lcContentRows?.sample).toBe('function');
    await waitFor(() => expect(window.__lcContentRows?.sample(1)).toContain('sampling for 1s'));
    expect(window.__lcContentRows?.sampleStop()).toContain('sampling stopped');
  });
});

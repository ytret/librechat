import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { ContentRowWindowingHost } from '../ContentRowWindowingHost';
import {
  ContentRowWindowingProvider,
  useOptionalContentRowWindowing,
} from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import { ContentPartRow } from '../ContentPartRow';
import { MessageShell } from '../MessageShell';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';

/**
 * Stage 3 task 3.7 — the provider is hosted in the real chat tree, and rows register only when the
 * flag is on (report 13 §6 Q6).
 *
 * The tree here is the shape `MessagesView` builds: its own `ContentRowWindowingHost`, then message
 * shells, then content rows. Rendering the real host is the point — its flag gating is what decides
 * whether any of windowing exists in the chat.
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
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getMessageAriaLabel: () => 'message label',
}));

let api: ContentRowWindowingRuntime | null;

/**
 * `useOptionalContentRowWindowing`, not the throwing variant: with the flag off there is no
 * provider, and the assertion that nothing is registered needs to observe that absence rather than
 * crash on it.
 */
function Probe() {
  api = useOptionalContentRowWindowing();
  return null;
}

const message = (id: string) => ({ messageId: id, conversationId: 'c1', text: '' }) as TMessage;

const reasoningPart = {
  type: ContentTypes.THINK,
  think: 'a reasoning body',
  thinkDuration: 1200,
} as Parameters<typeof ContentPartRow>[0]['part'];

/**
 * The chat tree as `MessagesView` assembles it, minus the scrolling plumbing that needs the whole
 * chat context. The host is the real one, so its flag gating is under test rather than re-stated.
 */
function ChatTree() {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = React.useRef(false);
  return (
    <div ref={scrollRef} className="scroll-root">
      <ContentRowWindowingHost
        scrollRootRef={scrollRef}
        conversationId="c1"
        pinnedToBottomRef={pinnedToBottomRef}
      >
        <Probe />
        <MessageShell messageId="m1" message={message('m1')}>
          <ContentPartRow messageId="m1" part={reasoningPart} idx={0}>
            <div data-testid="reasoning-body">{'a reasoning body'}</div>
          </ContentPartRow>
        </MessageShell>
      </ContentRowWindowingHost>
    </div>
  );
}

/** The same message content with no host above it, which is what the flag-off chat renders. */
function ChatTreeWithoutHost() {
  return (
    <MessageShell messageId="m1" message={message('m1')}>
      <ContentPartRow messageId="m1" part={reasoningPart} idx={0}>
        <div data-testid="reasoning-body">{'a reasoning body'}</div>
      </ContentPartRow>
    </MessageShell>
  );
}

const renderTree = (tree: React.ReactNode) => {
  const result = render(<RecoilRoot>{tree}</RecoilRoot>);
  flushFrames(4);
  return result;
};

function DefaultPolicyTree({ row }: { row: React.ReactNode }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = React.useRef(false);
  return (
    <div ref={scrollRef} className="scroll-root">
      <ContentRowWindowingProvider
        scrollRootRef={scrollRef}
        conversationId="c1"
        pinnedToBottomRef={pinnedToBottomRef}
      >
        <Probe />
        {row}
      </ContentRowWindowingProvider>
    </div>
  );
}

const rowShells = () => document.querySelectorAll('[data-content-virtual-row="true"]').length;

describe('rows in the real chat tree', () => {
  it('registers an approved part as a row while the flag is on', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(<ChatTree />);

    expect(rowShells()).toBe(1);
    expect(api?.getDiagnostics().registeredRows).toBe(1);
    expect(screen.getByTestId('reasoning-body')).toBeInTheDocument();
  });

  it('leaves the message shell identity intact around the row', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(<ChatTree />);

    const shell = document.getElementById('m1');
    expect(shell).toHaveClass('message-render');
    expect(shell?.querySelectorAll('.content-virtual-row')).toHaveLength(1);
  });

  it('renders the row through the real host with no provider of our own', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(<ChatTree />);

    // The probe resolves a context value, so a provider really is above the rows.
    expect(api).not.toBeNull();
    expect(api?.getDiagnostics().totalByKind.reasoning).toBe(1);
  });

  it('registers nothing and adds no attributes while the flag is off', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    renderTree(<ChatTree />);

    expect(rowShells()).toBe(0);
    expect(api).toBeNull();
    expect(screen.getByTestId('reasoning-body')).toBeInTheDocument();
    expect(document.getElementById('m1')).toHaveClass('message-render');
  });

  it('installs no observers while the flag is off', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    renderTree(<ChatTree />);

    expect(MockIntersectionObserver.instances).toHaveLength(0);
    expect(MockResizeObserver.instances).toHaveLength(0);
  });

  it('publishes no diagnostics handle while the flag is off', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    renderTree(<ChatTree />);

    expect((window as unknown as Record<string, unknown>).__lcContentRows).toBeUndefined();
  });
});

describe('a row without a provider', () => {
  it('renders its content as a plain block', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(<ChatTreeWithoutHost />);

    expect(rowShells()).toBe(0);
    expect(screen.getByTestId('reasoning-body')).toBeInTheDocument();
  });
});

describe('an undeclared row policy', () => {
  /**
   * Supervisor decision D1: `policy` is a required prop and an omitted or unrecognized value falls
   * back to `always-mounted`. The Stage 3 policy is an allow-list, so a row that does not declare
   * what it is may never window — the previous `'windowed'` default silently violated that.
   */
  it('cannot register as windowed when the policy is undefined', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(
      <DefaultPolicyTree
        row={
          <VirtualizedContentRow messageId="m1" kind="reasoning" sourceKey={0} policy={undefined}>
            <div data-testid="body">{'body'}</div>
          </VirtualizedContentRow>
        }
      />,
    );

    expect(api?.getDiagnostics().alwaysMountedRows).toBe(1);
    expect(api?.getDiagnostics().placeholderRows).toBe(0);
  });

  it('cannot register as windowed when a JavaScript caller omits the prop entirely', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    const RowWithoutPolicy = VirtualizedContentRow as unknown as React.ComponentType<
      Record<string, unknown>
    >;
    renderTree(
      <DefaultPolicyTree
        row={
          <RowWithoutPolicy messageId="m1" kind="reasoning" sourceKey={0}>
            <div data-testid="body">{'body'}</div>
          </RowWithoutPolicy>
        }
      />,
    );

    expect(api?.getDiagnostics().alwaysMountedRows).toBe(1);
    expect(api?.getDiagnostics().placeholderRows).toBe(0);
  });

  it('cannot register as windowed when the policy is not a known value', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(
      <DefaultPolicyTree
        row={
          <VirtualizedContentRow
            messageId="m1"
            kind="reasoning"
            sourceKey={0}
            policy={'sometimes' as unknown as 'windowed'}
          >
            <div data-testid="body">{'body'}</div>
          </VirtualizedContentRow>
        }
      />,
    );

    expect(api?.getDiagnostics().alwaysMountedRows).toBe(1);
    expect(api?.getDiagnostics().placeholderRows).toBe(0);
  });

  it('still honours an explicitly declared windowed policy', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    renderTree(
      <DefaultPolicyTree
        row={
          <VirtualizedContentRow messageId="m1" kind="reasoning" sourceKey={0} policy="windowed">
            <div data-testid="body">{'body'}</div>
          </VirtualizedContentRow>
        }
      />,
    );

    expect(api?.getDiagnostics().alwaysMountedRows).toBe(0);
    expect(api?.getDiagnostics().totalByKind.reasoning).toBe(1);
  });
});

import React, { useEffect, useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import { useContentRowInteraction } from '../contentRowInteraction';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import type { ContentRowInteraction } from '../contentRowInteraction';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';

/**
 * Stage 3 task 3.4 — row-local focus and pointer pins (report 13 §6 Q5).
 *
 * These drive the real `VirtualizedContentRow`, so what is asserted is the pin the provider
 * records for the row, not an internal flag.
 */

/* -------------------------------------------------------------------------- */
/* Frames and observers                                                       */
/* -------------------------------------------------------------------------- */

const originalRAF = global.requestAnimationFrame;
const originalCAF = global.cancelAnimationFrame;
const originalIO = global.IntersectionObserver;
const originalRO = global.ResizeObserver;

let frameQueue: FrameRequestCallback[] = [];
const flushFrames = (count = 1) => {
  for (let index = 0; index < count; index++) {
    const queue = frameQueue;
    frameQueue = [];
    act(() => {
      queue.forEach((callback) => callback(0));
    });
  }
};

class MockIntersectionObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  takeRecords = jest.fn(() => []);
  root = null;
  rootMargin = '0px';
  thresholds = [0];
  constructor(public callback: IntersectionObserverCallback) {}
}

class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: ResizeObserverCallback) {}
}

beforeEach(() => {
  frameQueue = [];
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
  setContentRowWindowingEnabled(true, { isDevelopment: true });
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  resetContentRowWindowingEnabledForTests();
  window.localStorage.clear();
  jest.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;

function Probe() {
  api = useContentRowWindowing();
  return null;
}

function Harness({ children }: { children?: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="scroll-root">
      <ContentRowWindowingProvider scrollRootRef={scrollRef} conversationId="conversation-1">
        <Probe />
        {children}
      </ContentRowWindowingProvider>
    </div>
  );
}

/** Reports the row interaction API it was given, and registers a portal on demand. */
function InteractionProbe({
  onValue,
  portalHost,
}: {
  onValue: (value: ContentRowInteraction | null) => void;
  portalHost?: React.RefObject<HTMLElement>;
}) {
  const interaction = useContentRowInteraction();
  useEffect(() => {
    onValue(interaction);
  }, [interaction, onValue]);
  useEffect(() => {
    if (!interaction || !portalHost?.current) {
      return;
    }
    return interaction.registerPortal(portalHost.current);
  }, [interaction, portalHost]);
  return null;
}

const row = (
  children: React.ReactNode,
  overrides: Partial<React.ComponentProps<typeof VirtualizedContentRow>> = {},
) => (
  <VirtualizedContentRow messageId="m1" kind="reasoning" sourceKey={0} ordinal={0} {...overrides}>
    {children}
  </VirtualizedContentRow>
);

const pins = () => api.getDiagnostics().pinsByReason;
const shell = () => document.querySelector('[data-content-virtual-row="true"]') as HTMLElement;

/* -------------------------------------------------------------------------- */
/* Focus pin                                                                  */
/* -------------------------------------------------------------------------- */

describe('focus pin', () => {
  it('holds the row while focus is inside it and releases it on the next task', () => {
    jest.useFakeTimers();
    render(
      <Harness>
        {row(
          <>
            <button type="button" data-testid="inside">
              {'inside'}
            </button>
            <button type="button" data-testid="outside">
              {'outside'}
            </button>
          </>,
        )}
      </Harness>,
    );

    expect(pins().focus).toBe(0);
    fireEvent.focus(document.querySelector('[data-testid="inside"]') as HTMLElement);
    expect(pins().focus).toBe(1);

    // Focus moving to another control inside the same row must not release the pin.
    fireEvent.blur(shell(), { relatedTarget: document.querySelector('[data-testid="outside"]') });
    act(() => jest.runOnlyPendingTimers());
    expect(pins().focus).toBe(1);
  });

  it('releases the focus pin once focus leaves the row', () => {
    jest.useFakeTimers();
    render(
      <Harness>
        {row(
          <button type="button" data-testid="inside">
            {'inside'}
          </button>,
        )}
      </Harness>,
    );

    fireEvent.focus(document.querySelector('[data-testid="inside"]') as HTMLElement);
    expect(pins().focus).toBe(1);

    fireEvent.blur(shell(), { relatedTarget: document.body });
    act(() => jest.runOnlyPendingTimers());
    expect(pins().focus).toBe(0);
  });

  it('keeps the pin when focus comes back before the next task runs', () => {
    jest.useFakeTimers();
    render(
      <Harness>
        {row(
          <button type="button" data-testid="inside">
            {'inside'}
          </button>,
        )}
      </Harness>,
    );

    fireEvent.focus(document.querySelector('[data-testid="inside"]') as HTMLElement);
    fireEvent.blur(shell(), { relatedTarget: document.body });
    // The button is the document's active element again, so the deferred release must stand down.
    act(() => {
      (document.querySelector('[data-testid="inside"]') as HTMLElement).focus();
    });
    act(() => jest.runOnlyPendingTimers());
    expect(pins().focus).toBe(1);
  });

  it('does not release the pin for focus that moved into a registered portal', () => {
    jest.useFakeTimers();
    const portalHost = React.createRef<HTMLElement>();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.id = 'portal-host-for-test';
    (portalHost as { current: HTMLElement | null }).current = outside;

    render(
      <Harness>
        {row(
          <>
            <InteractionProbe onValue={() => {}} portalHost={portalHost} />
            <button type="button" data-testid="inside">
              {'inside'}
            </button>
          </>,
        )}
      </Harness>,
    );

    fireEvent.focus(document.querySelector('[data-testid="inside"]') as HTMLElement);
    expect(pins().focus).toBe(1);

    fireEvent.blur(shell(), { relatedTarget: outside });
    act(() => jest.runOnlyPendingTimers());
    expect(pins().focus).toBe(1);

    outside.remove();
  });

  it('acquires one pin per focus, whatever the focus churn inside the row', () => {
    jest.useFakeTimers();
    render(
      <Harness>
        {row(
          <>
            <button type="button" data-testid="a">
              {'a'}
            </button>
            <button type="button" data-testid="b">
              {'b'}
            </button>
          </>,
        )}
      </Harness>,
    );

    fireEvent.focus(document.querySelector('[data-testid="a"]') as HTMLElement);
    fireEvent.blur(shell(), { relatedTarget: document.querySelector('[data-testid="b"]') });
    fireEvent.focus(document.querySelector('[data-testid="b"]') as HTMLElement);
    act(() => jest.runOnlyPendingTimers());

    expect(pins().focus).toBe(1);
    expect(api.getDiagnostics().pinsByReason.focus).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Pointer pin                                                                */
/* -------------------------------------------------------------------------- */

describe('pointer pin', () => {
  it('holds the row from pointerdown and releases on pointerup', () => {
    render(<Harness>{row(<div data-testid="content">{'content'}</div>)}</Harness>);

    expect(pins().interaction).toBe(0);
    fireEvent.pointerDown(shell());
    expect(pins().interaction).toBe(1);

    fireEvent.pointerUp(window);
    expect(pins().interaction).toBe(0);
  });

  it('releases on pointercancel and on a window blur', () => {
    render(<Harness>{row(<div data-testid="content">{'content'}</div>)}</Harness>);

    fireEvent.pointerDown(shell());
    expect(pins().interaction).toBe(1);
    fireEvent.pointerCancel(window);
    expect(pins().interaction).toBe(0);

    fireEvent.pointerDown(shell());
    expect(pins().interaction).toBe(1);
    fireEvent.blur(window);
    expect(pins().interaction).toBe(0);
  });

  it('releases only once for a pointerup that follows a pointercancel', () => {
    render(<Harness>{row(<div data-testid="content">{'content'}</div>)}</Harness>);

    fireEvent.pointerDown(shell());
    fireEvent.pointerCancel(window);
    fireEvent.pointerUp(window);
    expect(pins().interaction).toBe(0);
  });

  it('adds no window listener until a pointer interaction starts', () => {
    const addListener = jest.spyOn(window, 'addEventListener');
    render(<Harness>{row(<div data-testid="content">{'content'}</div>)}</Harness>);
    const beforePress = addListener.mock.calls.length;

    fireEvent.pointerDown(shell());
    const afterPress = addListener.mock.calls.length;
    expect(afterPress).toBeGreaterThan(beforePress);

    fireEvent.pointerUp(window);
    addListener.mockRestore();
  });
});

/* -------------------------------------------------------------------------- */
/* Teardown                                                                   */
/* -------------------------------------------------------------------------- */

describe('teardown', () => {
  it('releases focus and pointer pins, and drops its window listeners, on unmount', () => {
    jest.useFakeTimers();
    const removeListener = jest.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <Harness>
        {row(
          <button type="button" data-testid="inside">
            {'inside'}
          </button>,
        )}
      </Harness>,
    );

    fireEvent.pointerDown(shell());
    fireEvent.focus(document.querySelector('[data-testid="inside"]') as HTMLElement);
    act(() => jest.runOnlyPendingTimers());
    expect(pins().interaction).toBe(1);
    expect(pins().focus).toBe(1);

    unmount();
    expect(pins().interaction).toBe(0);
    expect(pins().focus).toBe(0);

    const removed = removeListener.mock.calls.map((call) => call[0]);
    expect(removed).toContain('pointerup');
    expect(removed).toContain('pointercancel');
    expect(removed).toContain('blur');
    removeListener.mockRestore();
  });

  it('drops a pending focus release when the row unmounts first', () => {
    jest.useFakeTimers();
    const { unmount } = render(
      <Harness>
        {row(
          <button type="button" data-testid="inside">
            {'inside'}
          </button>,
        )}
      </Harness>,
    );

    // The provider schedules timers of its own, so the assertion is the delta this row adds and
    // removes rather than an absolute count.
    const baseline = jest.getTimerCount();
    fireEvent.focus(document.querySelector('[data-testid="inside"]') as HTMLElement);
    fireEvent.blur(shell(), { relatedTarget: document.body });
    const withPendingRelease = jest.getTimerCount();
    expect(withPendingRelease).toBe(baseline + 1);

    unmount();
    // The pending focus release is cancelled with the row rather than firing against nothing.
    expect(jest.getTimerCount()).toBeLessThan(withPendingRelease);
    expect(pins().focus).toBe(0);

    act(() => jest.runOnlyPendingTimers());
    expect(pins().focus).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Row-scoped interaction API                                                 */
/* -------------------------------------------------------------------------- */

describe('interaction API for the row subtree', () => {
  it('lets a descendant pin the row it lives in', () => {
    let seen: ContentRowInteraction | null = null;
    render(
      <Harness>
        {row(
          <InteractionProbe
            onValue={(value) => {
              seen = value;
            }}
          />,
        )}
      </Harness>,
    );

    expect(seen).not.toBeNull();
    act(() => {
      (seen as unknown as ContentRowInteraction).pinRow('animation');
    });
    expect(pins().animation).toBe(1);
  });

  it('reports containment for the row subtree', () => {
    let seen: ContentRowInteraction | null = null;
    render(
      <Harness>
        {row(
          <>
            <InteractionProbe
              onValue={(value) => {
                seen = value;
              }}
            />
            <button type="button" data-testid="inside">
              {'inside'}
            </button>
          </>,
        )}
      </Harness>,
    );

    const interaction = seen as unknown as ContentRowInteraction;
    expect(interaction.containsNode(document.querySelector('[data-testid="inside"]'))).toBe(true);
    expect(interaction.containsNode(document.body)).toBe(false);
    expect(interaction.containsNode(null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Flag off                                                                   */
/* -------------------------------------------------------------------------- */

describe('with the flag off', () => {
  it('exposes no row interaction API and installs no pins', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    const seen: Array<ContentRowInteraction | null> = [];

    render(
      <Harness>
        <InteractionProbe onValue={(value) => seen.push(value)} />
        {row(<div data-testid="content">{'content'}</div>)}
      </Harness>,
    );

    expect(shell()).toBeNull();
    expect(seen[seen.length - 1] ?? null).toBeNull();

    fireEvent.pointerDown(document.querySelector('[data-testid="content"]') as HTMLElement);
    act(() => flushFrames(2));
    expect(pins().interaction).toBe(0);
  });
});

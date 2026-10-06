import React, { useEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import { useContentRowReadiness } from '../contentRowInteraction';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { CONTENT_ROW_QUIET_FRAMES } from '../contentRowTypes';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';

/**
 * Readiness reports must be attributed to the generation whose subtree reported them.
 *
 * `reportReady` is handed to content through context, and the provider that supplies it sits
 * *outside* the element that is re-keyed when a row's source changes. The row component therefore
 * stays mounted across a generation change and its `setReadiness` stays live, while the content
 * that was mounted in the earlier generation does not. A reporter captured before the change can
 * still be called afterwards, and if it records the generation that is live *at call time* it
 * approves a generation whose content has never reported — which makes the row windowable and lets
 * its not-yet-loaded content be replaced by a placeholder.
 *
 * Measured before the fix, with the sequence below: the row stayed mounted when nothing reported
 * (`placeholders: 0`), stayed mounted through a second settle cycle with still nothing reporting
 * (`placeholders: 0`), and became a placeholder (`placeholders: 1`) once the superseded generation's
 * reporter was called. The settled-without-report control is what rules out the row becoming a
 * placeholder on its own.
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

let clock = 0;
const originalNow = performance.now;

beforeEach(() => {
  frameQueue = [];
  clock = 0;
  reporters.length = 0;
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
  setContentRowWindowingEnabled(true, { isDevelopment: true });
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  performance.now = originalNow;
  resetContentRowWindowingEnabledForTests();
  window.localStorage.clear();
});

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

type Rect = { top: number; bottom: number };

const rects = new Map<Element, Rect>();
const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

let scrollTopValue = 0;

beforeEach(() => {
  rects.clear();
  scrollTopValue = 0;
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains('scroll-root')) {
      return { top: 0, bottom: 500, height: 500 } as DOMRect;
    }
    const rect = rects.get(this);
    if (!rect) {
      return { top: 0, bottom: 0, height: 0 } as DOMRect;
    }
    return { top: rect.top, bottom: rect.bottom, height: rect.bottom - rect.top } as DOMRect;
  });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return this.classList?.contains('scroll-root') ? scrollTopValue : 0;
    },
    set(value: number) {
      if (this.classList?.contains('scroll-root')) {
        scrollTopValue = value;
      }
    },
  });
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalScrollTop) {
    Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
  }
});

const setRowRect = (messageId: string, rect: Rect) => {
  const shell = document.querySelector(`[data-content-row-key="${messageId}:image:0"]`);
  if (shell) {
    rects.set(shell, rect);
  }
};

const scrollBy = (delta: number) => {
  scrollTopValue += delta;
  const root = document.querySelector('.scroll-root');
  act(() => {
    root?.dispatchEvent(new Event('scroll'));
  });
};

const layoutBelowBand = (count: number) => {
  for (let index = 0; index < count; index++) {
    setRowRect(`m${index}`, { top: -5000 - index * 100, bottom: -4900 - index * 100 });
  }
};

/** Settle the row, then push it out of range; only a windowable row becomes a placeholder. */
const settleAndScrollAway = (count: number) => {
  flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
  layoutBelowBand(count);
  scrollBy(10);
  flushFrames(4);
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;

function Probe() {
  api = useContentRowWindowing();
  return null;
}

type Reporter = { ready: () => void; failed: () => void };

/** Every mounted content instance's reporters, in mount order. */
const reporters: Reporter[] = [];

/**
 * Content that holds on to the reporters it was given and never reports on its own, so a test can
 * decide when each generation's report arrives.
 */
function SilentContent() {
  const readiness = useContentRowReadiness();

  useEffect(() => {
    if (!readiness) {
      return;
    }
    reporters.push({
      ready: () => readiness.reportReady(),
      failed: () => readiness.reportFailed(),
    });
  }, [readiness]);

  return <div data-testid="image" />;
}

function Row({ messageId, sourceKey }: { messageId: string; sourceKey: string }) {
  return (
    <div className="message-render" id={messageId}>
      <VirtualizedContentRow
        messageId={messageId}
        kind="image"
        sourceKey={0}
        ordinal={0}
        contentKey={sourceKey}
        policy="unstable-until-settled"
      >
        <SilentContent />
      </VirtualizedContentRow>
    </div>
  );
}

function Harness({ children }: { children?: React.ReactNode }) {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRootRef} className="scroll-root">
      <ContentRowWindowingProvider scrollRootRef={scrollRootRef} conversationId="conversation-1">
        <Probe />
        {children}
      </ContentRowWindowingProvider>
    </div>
  );
}

const renderRow = (sourceKey: string) => {
  const result = render(
    <Harness>
      <Row messageId="m0" sourceKey={sourceKey} />
    </Harness>,
  );
  flushFrames(2);
  return result;
};

const placeholderRows = () => api.getDiagnostics().placeholderRows;
const rowGeneration = () =>
  Number(
    document
      .querySelector('[data-content-virtual-row="true"]')
      ?.getAttribute('data-content-generation'),
  );

/** The reporter belonging to the first generation, still callable after the row has moved on. */
const staleReporter = () => reporters[0];
const liveReporter = () => reporters[reporters.length - 1];

describe('readiness reported across a generation change', () => {
  it('stays mounted when nothing has reported, so the check below is not vacuous', () => {
    renderRow('a');
    settleAndScrollAway(1);
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);
  });

  it('does not let a superseded generation make the current one windowable', () => {
    const { rerender } = renderRow('a');
    expect(rowGeneration()).toBe(1);

    // A new source: the row re-keys, and its content has not reported.
    rerender(
      <Harness>
        <Row messageId="m0" sourceKey="b" />
      </Harness>,
    );
    flushFrames(2);
    expect(rowGeneration()).toBe(2);
    expect(reporters.length).toBe(2);

    // The report from the generation that is gone arrives late.
    act(() => {
      staleReporter().ready();
    });

    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(0);
  });

  it('becomes windowable once the generation that is current reports', () => {
    const { rerender } = renderRow('a');
    rerender(
      <Harness>
        <Row messageId="m0" sourceKey="b" />
      </Harness>,
    );
    flushFrames(2);

    act(() => {
      liveReporter().ready();
    });

    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(1);
  });

  it('keeps the current generation ready when a superseded one reports failure', () => {
    const { rerender } = renderRow('a');
    rerender(
      <Harness>
        <Row messageId="m0" sourceKey="b" />
      </Harness>,
    );
    flushFrames(2);

    act(() => {
      liveReporter().ready();
    });
    act(() => {
      staleReporter().failed();
    });

    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(1);
  });
});

import React, { useCallback, useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import { useContentRowReadiness } from '../contentRowInteraction';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { CONTENT_ROW_QUIET_FRAMES } from '../contentRowTypes';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';
import Image, { _resetImageCaches } from '../../Content/Image';

/**
 * Stage 3 task 3.6 — image readiness and the explicit policy transition (report 13 §6 Q3).
 *
 * A known-size image row starts `unstable-until-settled`; the image reports its load, and only then
 * does the row become `windowed` and therefore unmountable. A failed load keeps it mounted.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  Skeleton: () => <span data-testid="skeleton" />,
  Button: ({ children, ...props }: { children?: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
}));

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
  _resetImageCaches();
});

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

type Rect = { top: number; bottom: number };

let rootRect: Rect = { top: 0, bottom: 500 };
const rects = new Map<Element, Rect>();

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

let scrollTopValue = 0;

beforeEach(() => {
  rects.clear();
  rootRect = { top: 0, bottom: 500 };
  scrollTopValue = 0;
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains('scroll-root')) {
      return { top: rootRect.top, bottom: rootRect.bottom, height: 500 } as DOMRect;
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

/**
 * Positions one row's shell. The selector is the row's own key attribute, not a test-only hook:
 * `VirtualizedContentRow` is the component under test, so the rect must land on the shell it
 * actually renders, or the row silently looks like it is inside the viewport.
 */
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

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;

/** The image's side of the contract: it reports readiness and measures its own element. */
function FakeImage({ autoReady }: { autoReady?: 'load' | 'fail' | null }) {
  const readiness = useContentRowReadiness();
  const reported = useRef(false);

  const report = useCallback(
    (status: 'load' | 'fail') => {
      if (reported.current) {
        return;
      }
      reported.current = true;
      if (status === 'load') {
        readiness?.reportReady();
      } else {
        readiness?.reportFailed();
      }
    },
    [readiness],
  );

  React.useEffect(() => {
    if (autoReady) {
      report(autoReady);
    }
  }, [autoReady, report]);

  return <div data-testid="image" />;
}

function Row({
  messageId,
  policy,
  autoReady = null,
  revision = 0,
}: {
  messageId: string;
  policy: 'windowed' | 'always-mounted' | 'unstable-until-settled';
  autoReady?: 'load' | 'fail' | null;
  revision?: number;
}) {
  return (
    <div className="message-render" id={messageId}>
      <VirtualizedContentRow
        messageId={messageId}
        kind="image"
        sourceKey={0}
        ordinal={0}
        stateKey={revision}
        policy={policy}
      >
        <FakeImage autoReady={autoReady} />
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

function Probe() {
  api = useContentRowWindowing();
  return null;
}

const placeholderRows = () => api.getDiagnostics().placeholderRows;

const settleAndScrollAway = (count: number) => {
  flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
  layoutBelowBand(count);
  scrollBy(10);
  flushFrames(4);
};

describe('image readiness', () => {
  it('leaves a known-size image row mounted until its image reports ready', () => {
    render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" />
      </Harness>,
    );
    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(0);
  });

  it('makes the row windowable once the image reports ready', () => {
    render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" autoReady="load" />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(1);
    expect(api.getDiagnostics().attemptsBySource.policy).toBe(1);
  });

  it('keeps the row mounted when the image reports failure', () => {
    render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" autoReady="fail" />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);
    expect(api.getDiagnostics().alwaysMountedRows).toBe(1);
  });

  it('ignores readiness reported to a row that is not unstable-until-settled', () => {
    render(
      <Harness>
        <Row messageId="m0" policy="always-mounted" autoReady="load" />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);
    expect(api.getDiagnostics().attemptsBySource.policy).toBe(0);
  });

  it('requires readiness again for the generation that follows a remount', () => {
    const { rerender } = render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" autoReady="load" />
      </Harness>,
    );
    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(1);

    // A new source is a new generation whose content has not reported yet: the previous
    // generation's readiness must not carry over.
    rerender(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" revision={1} />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);

    // Once the new generation's image reports, the row is windowable again.
    rerender(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" revision={1} autoReady="load" />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The real image component                                                   */
/* -------------------------------------------------------------------------- */

describe('the real Image component', () => {
  /**
   * The policy the classifier gives a known-size image. It is passed explicitly because a
   * `VirtualizedContentRow` that omits `policy` defaults to `windowed`, which would make the
   * readiness signal a no-op and the test vacuous.
   */
  const realImageRow = (
    <div className="message-render" id="m0">
      <VirtualizedContentRow
        messageId="m0"
        kind="image"
        sourceKey={0}
        ordinal={0}
        policy="unstable-until-settled"
      >
        <Image imagePath="/images/test.png" altText="Test image" width={800} height={600} />
      </VirtualizedContentRow>
    </div>
  );

  it('makes its row windowable after the image loads and paints', () => {
    render(<Harness>{realImageRow}</Harness>);
    expect(api.getDiagnostics().attemptsBySource.policy).toBe(0);

    fireEvent.load(document.querySelector('img') as HTMLImageElement);
    flushFrames(4);

    expect(api.getDiagnostics().attemptsBySource.policy).toBe(1);

    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(1);
  });

  it('keeps its row mounted when the image fails to load', () => {
    render(<Harness>{realImageRow}</Harness>);

    fireEvent.error(document.querySelector('img') as HTMLImageElement);
    flushFrames(4);

    expect(api.getDiagnostics().alwaysMountedRows).toBe(1);
    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(0);
  });
});

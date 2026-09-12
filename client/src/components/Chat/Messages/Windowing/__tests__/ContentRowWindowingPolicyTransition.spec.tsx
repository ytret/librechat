import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import {
  CONTENT_ROW_QUIET_FRAMES,
  LARGE_ROW_HEIGHT_PX,
  type ContentRowPolicy,
  type ContentRowWindowingRuntime,
} from '../contentRowTypes';

/**
 * Stage 3 task 3.6 — the `unstable-until-settled` → `windowed` transition (report 13 §6 Q3).
 *
 * A policy-only `updateRow` used to be silently inert: `needsSettlementTracking` requires
 * `policy === 'windowed'`, so leaving that policy meant no settlement budget was ever armed, and
 * the row stayed `MOUNTED_MEASURED_UNSETTLED` forever with `canRowUnmount` false and nothing
 * reporting an error. These tests cover both directions of the transition.
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
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  performance.now = originalNow;
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

const setRowRect = (messageId: string, rect: Rect) => {
  const shell = document.querySelector(`[data-row-shell="${messageId}"]`);
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

function layoutBelowBand(count: number) {
  for (let index = 0; index < count; index++) {
    setRowRect(`m${index}`, { top: -5000 - index * 100, bottom: -4900 - index * 100 });
  }
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;
const rowState = new Map<string, { mounted: boolean; generation: number; height?: number }>();

function Row({
  messageId,
  policy,
  measuredHeight = 300,
  forceMounted = false,
}: {
  messageId: string;
  policy: ContentRowPolicy;
  measuredHeight?: number;
  forceMounted?: boolean;
}) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const token = useRef(createRowToken(messageId));
  const scopeToken = useRef(createScopeToken());
  const [state, setState] = React.useState<{
    mounted: boolean;
    generation: number;
    height?: number;
  }>({ mounted: true, generation: 1 });
  rowState.set(messageId, state);

  const latest = useRef({ messageId, policy, forceMounted });
  latest.current = { messageId, policy, forceMounted };

  useLayoutEffect(() => {
    const current = latest.current;
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId: current.messageId,
      debugKey: `${current.messageId}:image:0`,
      kind: 'image',
      fingerprint: composeFingerprint({ kind: 'image', sourceKey: 0 }),
      policy: current.policy,
      forceMounted: current.forceMounted,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, generation: number, height?: number) =>
        setState({ mounted, generation, height }),
    });
  }, [windowing]);

  useLayoutEffect(() => {
    windowing.updateRow(token.current, { policy, forceMounted });
  }, [windowing, policy, forceMounted]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const bucket = windowing.getLayoutBucket();
    const unregister = windowing.registerMountedContent({
      token: token.current,
      generation: state.generation,
      layoutBucket: bucket,
      element,
    });
    windowing.reportMountedContentHeight(
      token.current,
      state.generation,
      bucket,
      element,
      measuredHeight,
      'layout-effect',
    );
    return unregister;
  }, [windowing, state.generation, state.mounted, measuredHeight]);

  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef} data-row-shell={messageId}>
        {state.mounted ? <div key={state.generation} ref={contentRef} /> : null}
      </div>
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
const isMounted = (messageId: string) => rowState.get(messageId)?.mounted === true;

function settleAll() {
  flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
}

/** Let rows settle, then push them far above the viewport so they can be unmounted. */
function settleAndScrollAway(count: number) {
  settleAll();
  layoutBelowBand(count);
  scrollBy(10);
  flushFrames(4);
}

/* -------------------------------------------------------------------------- */
/* Entering windowed                                                          */
/* -------------------------------------------------------------------------- */

describe('entering the windowed policy', () => {
  it('leaves an unstable-until-settled row mounted', () => {
    render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);
    expect(isMounted('m0')).toBe(true);
    expect(api.getDiagnostics().settlementTimeouts).toBe(0);
  });

  it('arms settlement on the policy flip, so the row can settle and unmount', () => {
    const { rerender } = render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" />
      </Harness>,
    );
    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(0);

    // The image reports ready: the row's policy becomes windowed.
    rerender(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);

    expect(placeholderRows()).toBe(1);
    expect(isMounted('m0')).toBe(false);
  });

  it('attributes the armed budget to the policy transition', () => {
    const { rerender } = render(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" />
      </Harness>,
    );
    expect(api.getDiagnostics().attemptsBySource.policy).toBe(0);

    rerender(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );

    expect(api.getDiagnostics().attemptsBySource.policy).toBe(1);
  });

  it('does not re-arm when the policy is written again unchanged', () => {
    const { rerender } = render(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );
    settleAll();
    const before = api.getDiagnostics().attemptsBySource.policy;

    rerender(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );
    expect(api.getDiagnostics().attemptsBySource.policy).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* Leaving windowed                                                           */
/* -------------------------------------------------------------------------- */

describe('leaving the windowed policy', () => {
  it('drops a pending settlement budget instead of demoting the row later', () => {
    const { rerender } = render(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );
    // A budget is in flight right after mount, before the quiet frames have elapsed.
    expect(api.getDiagnostics().settlementDeadlineRows).toBe(1);

    // The image is remounted and its readiness resets, so the row returns to unstable-until-settled.
    rerender(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" />
      </Harness>,
    );
    expect(api.getDiagnostics().settlementDeadlineRows).toBe(0);

    // Past the timeout: an expired budget must not turn a temporary policy into a permanent one.
    act(() => {
      clock += 5000;
    });
    flushFrames(4);
    expect(api.getDiagnostics().settlementTimeouts).toBe(0);
    expect(api.getDiagnostics().alwaysMountedRows).toBe(0);

    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(0);
  });

  it('re-arms when the row returns to windowed', () => {
    const { rerender } = render(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );
    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(1);

    rerender(
      <Harness>
        <Row messageId="m0" policy="unstable-until-settled" />
      </Harness>,
    );

    rerender(
      <Harness>
        <Row messageId="m0" policy="windowed" />
      </Harness>,
    );
    expect(api.getDiagnostics().attemptsBySource.policy).toBe(1);

    settleAndScrollAway(1);
    expect(placeholderRows()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Interaction with the other row rules                                       */
/* -------------------------------------------------------------------------- */

describe('the transition respects the other row rules', () => {
  it('does not let a force-mounted row unmount after the flip', () => {
    render(
      <Harness>
        <Row messageId="m0" policy="windowed" forceMounted />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);
    expect(api.getDiagnostics().forcedRows).toBe(1);
  });

  it('still demotes a row measured past the large-row threshold', () => {
    render(
      <Harness>
        <Row
          messageId="m0"
          policy="unstable-until-settled"
          measuredHeight={LARGE_ROW_HEIGHT_PX + 1}
        />
      </Harness>,
    );
    settleAndScrollAway(1);

    expect(placeholderRows()).toBe(0);
    expect(api.getDiagnostics().oversizedRows).toBe(1);
  });
});

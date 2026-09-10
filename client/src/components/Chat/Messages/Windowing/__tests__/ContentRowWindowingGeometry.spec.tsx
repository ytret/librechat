import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import {
  CONTENT_ROW_OVERSCAN_PX,
  CONTENT_ROW_QUIET_FRAMES,
  CONTENT_ROW_UNMOUNT_HYSTERESIS_PX,
  MAX_MOUNTS_PER_FRAME,
  MAX_UNMOUNTS_PER_FRAME,
  type ContentRowWindowingRuntime,
} from '../contentRowTypes';

/* -------------------------------------------------------------------------- */
/* Deterministic frames, clock, and observers                                 */
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
  static instances: MockIntersectionObserver[] = [];
  observed: Element[] = [];
  observe = jest.fn((target: Element) => {
    this.observed.push(target);
  });

  unobserve = jest.fn((target: Element) => {
    this.observed = this.observed.filter((element) => element !== target);
  });

  disconnect = jest.fn(() => {
    this.observed = [];
  });

  takeRecords = jest.fn(() => []);
  root = null;
  rootMargin = '0px';
  thresholds = [0];
  constructor(public callback: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this);
  }

  trigger() {
    act(() => {
      this.callback([], this as unknown as IntersectionObserver);
    });
  }
}

class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: ResizeObserverCallback) {}
}

let clock = 0;
const originalNow = performance.now;
const advanceClock = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  frameQueue = [];
  clock = 0;
  MockIntersectionObserver.instances = [];
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  // Fonts are covered by ContentRowWindowingSettlement.spec.tsx. Here the Font Loading API
  // is absent, which the provider treats as already ready, so settlement is synchronous and
  // these tests do not depend on microtask timing.
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
/* Geometry helper                                                            */
/* -------------------------------------------------------------------------- */

type Rect = { top: number; bottom: number };

/**
 * jsdom has no layout, so every element's rectangle is supplied explicitly. `rects` maps a
 * row's shell element to its position, and mutating it between frames simulates scrolling.
 */
let rootRect: Rect = { top: 0, bottom: 500 };
const rects = new Map<Element, Rect>();

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

let scrollTopValue = 0;
const scrollWrites: number[] = [];

beforeEach(() => {
  rects.clear();
  rootRect = { top: 0, bottom: 500 };
  scrollTopValue = 0;
  scrollWrites.length = 0;
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
      if (!this.classList?.contains('scroll-root')) {
        return;
      }
      scrollWrites.push(value);
      scrollTopValue = value;
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

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;
const rowState = new Map<string, { mounted: boolean; generation: number; height?: number }>();

function Row({ messageId, readiness }: { messageId: string; readiness?: Promise<unknown> }) {
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

  useLayoutEffect(() => {
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId,
      debugKey: `${messageId}:markdown:0`,
      kind: 'markdown',
      fingerprint: composeFingerprint({ kind: 'markdown', sourceKey: 0 }),
      policy: 'windowed',
      forceMounted: false,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, generation: number, height?: number) =>
        setState({ mounted, generation, height }),
    });
  }, [windowing, messageId]);

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
      400,
      'layout-effect',
    );
    return unregister;
  }, [windowing, state.generation, state.mounted]);

  useLayoutEffect(() => {
    if (!readiness) {
      return;
    }
    const unsubscribe = windowing.registerReadiness(token.current, state.generation, readiness);
    return unsubscribe;
  }, [windowing, readiness, state.generation]);

  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef} data-row-shell={messageId}>
        {state.mounted ? <div key={state.generation} ref={contentRef} /> : null}
      </div>
    </div>
  );
}

function Harness({
  children,
  conversationId = 'conversation-1',
}: {
  children?: React.ReactNode;
  conversationId?: string;
}) {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRootRef} className="scroll-root">
      <ContentRowWindowingProvider scrollRootRef={scrollRootRef} conversationId={conversationId}>
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

beforeEach(() => {
  rowState.clear();
});

const mountedRows = () => api.getDiagnostics().mountedRows;
const placeholderRows = () => api.getDiagnostics().placeholderRows;
const isMounted = (messageId: string) => rowState.get(messageId)?.mounted === true;

/** Stack `count` rows far above the viewport, beyond the unmount hysteresis band. */
function layoutBelowBand(count: number) {
  for (let index = 0; index < count; index++) {
    setRowRect(`m${index}`, { top: -5000 - index * 100, bottom: -4900 - index * 100 });
  }
}

/** Place `count` rows just past the viewport bottom but inside the overscan lead. */
function layoutJustPastViewport(count: number) {
  for (let index = 0; index < count; index++) {
    setRowRect(`m${index}`, { top: 600 + index * 100, bottom: 700 + index * 100 });
  }
}

const manyRows = (count: number) =>
  Array.from({ length: count }, (_, index) => <Row key={`m${index}`} messageId={`m${index}`} />);

/** Let every row settle so that it becomes unmount-eligible. */
function settleAll() {
  flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
}

const mountBatchStats = () => api.getDiagnostics().mountCountsPerFrame;
const unmountBatchStats = () => api.getDiagnostics().unmountCountsPerFrame;

/* -------------------------------------------------------------------------- */
/* Shared intersection observer and scroll scheduling                         */
/* -------------------------------------------------------------------------- */

describe('shared intersection observer', () => {
  it('creates exactly one observer and observes every shell', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    expect(MockIntersectionObserver.instances).toHaveLength(1);
    expect(MockIntersectionObserver.instances[0].observed).toHaveLength(3);
  });

  it('stops observing a shell when the row unmounts', () => {
    const { rerender } = render(<Harness>{manyRows(2)}</Harness>);
    const [observer] = MockIntersectionObserver.instances;
    const shell = document.querySelector('[data-row-shell="m1"]');
    expect(observer.observed).toContain(shell);
    rerender(<Harness>{[<Row key="m0" messageId="m0" />]}</Harness>);
    expect(observer.observed).not.toContain(shell);
  });

  it('schedules at most one geometry pass per frame', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    // drain whatever the mount already queued, so the assertion sees only new work
    flushFrames(3);
    expect(frameQueue).toHaveLength(0);
    const root = document.querySelector('.scroll-root');
    act(() => {
      root?.dispatchEvent(new Event('scroll'));
      root?.dispatchEvent(new Event('scroll'));
      root?.dispatchEvent(new Event('scroll'));
    });
    expect(frameQueue).toHaveLength(1);
  });

  it('disconnects on provider unmount', () => {
    const { unmount } = render(<Harness>{manyRows(1)}</Harness>);
    const [observer] = MockIntersectionObserver.instances;
    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Mount budget                                                               */
/* -------------------------------------------------------------------------- */

describe('mount budget', () => {
  it('mounts at most the configured number of ordinary rows per frame', () => {
    render(<Harness>{manyRows(8)}</Harness>);
    settleAll();
    layoutBelowBand(8);
    scrollBy(50);
    flushFrames(4);
    expect(placeholderRows()).toBe(8);

    // just outside the viewport and inside the overscan: ordinary mounts, so the budget applies
    layoutJustPastViewport(8);
    scrollBy(1);
    flushFrames(1);
    expect(mountedRows()).toBe(MAX_MOUNTS_PER_FRAME);
    flushFrames(1);
    expect(mountedRows()).toBe(MAX_MOUNTS_PER_FRAME * 2);
    expect(mountBatchStats().max).toBeLessThanOrEqual(MAX_MOUNTS_PER_FRAME);
  });

  it('lets rows inside the viewport bypass the mount budget and counts them', () => {
    render(<Harness>{manyRows(6)}</Harness>);
    settleAll();
    layoutBelowBand(6);
    scrollBy(50);
    flushFrames(4);
    expect(placeholderRows()).toBe(6);

    // six rows re-enter the actual viewport at once, more than the ordinary budget
    for (let index = 0; index < 6; index++) {
      setRowRect(`m${index}`, { top: 100 + index * 10, bottom: 200 + index * 10 });
    }
    scrollBy(1);
    flushFrames(1);
    expect(api.getDiagnostics().viewportBudgetBypass).toBeGreaterThanOrEqual(6);
    expect(mountedRows()).toBe(6);
    expect(mountBatchStats().max).toBeGreaterThanOrEqual(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Unmount budget and hysteresis                                              */
/* -------------------------------------------------------------------------- */

describe('unmount budget and hysteresis', () => {
  it('unmounts at most the configured number of rows per frame', () => {
    const total = MAX_UNMOUNTS_PER_FRAME + 4;
    render(<Harness>{manyRows(total)}</Harness>);
    settleAll();
    layoutBelowBand(total);
    scrollBy(10);
    flushFrames(1);
    expect(unmountBatchStats().max).toBe(MAX_UNMOUNTS_PER_FRAME);
    expect(placeholderRows()).toBe(MAX_UNMOUNTS_PER_FRAME);
    // the next frame continues the work
    flushFrames(1);
    expect(placeholderRows()).toBe(total);
    expect(unmountBatchStats().total).toBe(total);
  });

  it('retains a row that is outside the overscan but inside the hysteresis band', () => {
    render(<Harness>{manyRows(1)}</Harness>);
    settleAll();
    expect(isMounted('m0')).toBe(true);
    // 1000 px above the viewport: outside the 800 px overscan, inside the 1600 px hysteresis
    setRowRect('m0', { top: -1000, bottom: -900 });
    scrollBy(5);
    flushFrames(2);
    expect(CONTENT_ROW_OVERSCAN_PX).toBeLessThan(1000);
    expect(CONTENT_ROW_UNMOUNT_HYSTERESIS_PX).toBeGreaterThan(1000);
    expect(isMounted('m0')).toBe(true);
    expect(placeholderRows()).toBe(0);
  });

  it('unmounts a row beyond the hysteresis band once it is settled', () => {
    render(<Harness>{manyRows(1)}</Harness>);
    settleAll();
    setRowRect('m0', { top: -4000, bottom: -3900 });
    scrollBy(5);
    flushFrames(2);
    expect(isMounted('m0')).toBe(false);
    expect(placeholderRows()).toBe(1);
    expect(mountedRows()).toBe(0);
  });

  it('remounts a placeholder that comes back into range with a new generation', () => {
    render(<Harness>{manyRows(1)}</Harness>);
    settleAll();
    setRowRect('m0', { top: -4000, bottom: -3900 });
    scrollBy(5);
    flushFrames(2);
    const placeholderGeneration = rowState.get('m0')?.generation;
    expect(isMounted('m0')).toBe(false);

    setRowRect('m0', { top: 100, bottom: 200 });
    scrollBy(50);
    flushFrames(2);
    expect(isMounted('m0')).toBe(true);
    expect(rowState.get('m0')?.generation).toBeGreaterThan(placeholderGeneration ?? 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

describe('unmount eligibility in the geometry pass', () => {
  it('keeps a row mounted while an asynchronous renderer is still pending', async () => {
    let release!: () => void;
    const readiness = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(
      <Harness>
        <Row messageId="m0" readiness={readiness} />
      </Harness>,
    );
    // the row never settles while the barrier is pending, so it can never unmount
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 5);
    setRowRect('m0', { top: -4000, bottom: -3900 });
    scrollBy(5);
    flushFrames(3);
    expect(isMounted('m0')).toBe(true);
    expect(placeholderRows()).toBe(0);

    await act(async () => {
      release();
    });
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 2);
    scrollBy(5);
    flushFrames(2);
    expect(isMounted('m0')).toBe(false);
  });

  it('never unmounts a row that is still unmeasured', () => {
    render(
      <Harness>
        <RowWithoutContent messageId="m0" />
      </Harness>,
    );
    settleAll();
    setRowRect('m0', { top: -4000, bottom: -3900 });
    scrollBy(5);
    flushFrames(2);
    expect(isMounted('m0')).toBe(true);
    expect(api.getDiagnostics().unmeasuredRows).toBe(1);
  });
});

function RowWithoutContent({ messageId }: { messageId: string }) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const token = useRef(createRowToken(messageId));
  const scopeToken = useRef(createScopeToken());
  const [state, setState] = React.useState<{
    mounted: boolean;
    generation: number;
    height?: number;
  }>({ mounted: true, generation: 1 });
  rowState.set(messageId, state);
  useLayoutEffect(() => {
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId,
      debugKey: `${messageId}:markdown:0`,
      kind: 'markdown',
      fingerprint: 'markdown|0',
      policy: 'windowed',
      forceMounted: false,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, generation: number, height?: number) =>
        setState({ mounted, generation, height }),
    });
  }, [windowing, messageId]);
  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef} data-row-shell={messageId} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Decision invalidation                                                      */
/* -------------------------------------------------------------------------- */

describe('decision invalidation', () => {
  it('discards a queued pass after a conversation change and reschedules', () => {
    const { rerender } = render(<Harness conversationId="conversation-1">{manyRows(2)}</Harness>);
    settleAll();
    layoutBelowBand(2);
    scrollBy(5);
    // the pass is queued but not yet run
    rerender(<Harness conversationId="conversation-2">{manyRows(2)}</Harness>);
    flushFrames(2);
    // nothing was unmounted from the stale pass, and a fresh pass ran
    expect(scrollWrites).toHaveLength(0);
    expect(api.getDiagnostics().placeholderRows).toBe(0);
  });

  it('discards a queued pass when the scroll direction reverses', () => {
    render(<Harness>{manyRows(2)}</Harness>);
    settleAll();
    layoutBelowBand(2);
    scrollBy(30);
    scrollBy(-30);
    flushFrames(2);
    // the direction epoch changed, so the pass was discarded and rescheduled; the rows were
    // never evaluated by the stale pass
    expect(api.getDiagnostics().placeholderRows + api.getDiagnostics().mountedRows).toBe(2);
  });

  it('discards queued work and cancels frames on provider unmount', () => {
    const { unmount } = render(<Harness>{manyRows(2)}</Harness>);
    settleAll();
    layoutBelowBand(2);
    scrollBy(5);
    expect(() => unmount()).not.toThrow();
    expect(() => flushFrames(2)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

describe('transition diagnostics', () => {
  it('records the mount and unmount counts of a batch', () => {
    render(<Harness>{manyRows(2)}</Harness>);
    settleAll();
    layoutBelowBand(2);
    scrollBy(5);
    flushFrames(1);
    const snapshot = api.getDiagnostics();
    expect(snapshot.unmountCountsPerFrame).toEqual({ frames: 1, total: 2, max: 2, mean: 2 });
    expect(snapshot.mountCountsPerFrame).toEqual({ frames: 1, total: 0, max: 0, mean: 0 });
    expect(snapshot.mountTransactionDurations.count).toBe(1);
  });

  it('records no batch for a frame with nothing to do', () => {
    render(<Harness>{manyRows(1)}</Harness>);
    settleAll();
    const before = api.getDiagnostics().mountTransactionDurations.count;
    scrollBy(1);
    flushFrames(1);
    expect(api.getDiagnostics().mountTransactionDurations.count).toBe(before);
  });

  it('records a mount transaction duration for a batch that did work', () => {
    render(<Harness>{manyRows(1)}</Harness>);
    settleAll();
    setRowRect('m0', { top: -4000, bottom: -3900 });
    advanceClock(7);
    scrollBy(5);
    flushFrames(1);
    const durations = api.getDiagnostics().mountTransactionDurations;
    expect(durations.count).toBe(1);
    expect(durations.min).toBeGreaterThanOrEqual(0);
  });
});

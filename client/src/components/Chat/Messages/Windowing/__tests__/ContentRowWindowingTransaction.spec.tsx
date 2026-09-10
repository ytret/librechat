import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import {
  CONTENT_ROW_QUIET_FRAMES,
  MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX,
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
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  resize(target: Element, height: number) {
    act(() => {
      this.callback(
        [
          {
            target,
            borderBoxSize: [{ blockSize: height }],
            contentRect: { height },
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    });
  }
}

let clock = 0;
const originalNow = performance.now;
const advanceClock = (ms: number) => {
  clock += ms;
};

beforeEach(() => {
  frameQueue = [];
  clock = 0;
  MockResizeObserver.instances = [];
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
/* Layout model                                                               */
/* -------------------------------------------------------------------------- */

const VIEWPORT_HEIGHT = 500;
const ROW_HEIGHT = 800;

let scrollTopValue = 0;
const scrollWrites: number[] = [];
/** Real, in-DOM height of each row while it is mounted. */
const realHeights = new Map<string, number>();

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
let orderedIds: string[] = [];

const heightFor = (messageId: string): number => {
  const state = rowState.get(messageId);
  if (state?.mounted === false) {
    // a placeholder renders at its exact cached height
    return state.height ?? ROW_HEIGHT;
  }
  return realHeights.get(messageId) ?? ROW_HEIGHT;
};

/** Rectangles are computed from the live layout model, so a committed mount state is
 *  reflected by the next read — which is exactly what §11.1 step 5 relies on. */
const rectFor = (messageId: string) => {
  let cursor = 0;
  for (const id of orderedIds) {
    const height = heightFor(id);
    if (id === messageId) {
      return { top: cursor - scrollTopValue, bottom: cursor - scrollTopValue + height, height };
    }
    cursor += height;
  }
  return { top: 0, bottom: 0, height: 0 };
};

beforeEach(() => {
  scrollTopValue = 0;
  scrollWrites.length = 0;
  realHeights.clear();
  jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    if (this.classList.contains('scroll-root')) {
      return { top: 0, bottom: VIEWPORT_HEIGHT, height: VIEWPORT_HEIGHT } as DOMRect;
    }
    const messageId = this.getAttribute('data-row-shell');
    if (messageId) {
      return rectFor(messageId) as DOMRect;
    }
    return { top: 0, bottom: 0, height: 0 } as DOMRect;
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
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!this.classList?.contains('scroll-root')) {
        return 0;
      }
      return orderedIds.reduce((total, id) => total + heightFor(id), 0);
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return this.classList?.contains('scroll-root') ? VIEWPORT_HEIGHT : 0;
    },
  });
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
  void scrollHeightDescriptor;
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  if (originalScrollTop) {
    Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
  }
});

const scrollTo = (value: number) => {
  scrollTopValue = value;
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

function Row({ messageId }: { messageId: string }) {
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
  // rows render in document order, which is the order the layout model lays them out in
  if (!orderedIds.includes(messageId)) {
    orderedIds.push(messageId);
  }

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
      realHeights.get(messageId) ?? ROW_HEIGHT,
      'layout-effect',
    );
    return unregister;
  }, [windowing, messageId, state.generation, state.mounted]);

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
  scrollRootRef,
  pinnedToBottomRef,
}: {
  children?: React.ReactNode;
  scrollRootRef?: React.RefObject<HTMLDivElement>;
  pinnedToBottomRef?: React.RefObject<boolean>;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRootRef ?? internalRef} className="scroll-root">
      <ContentRowWindowingProvider
        scrollRootRef={scrollRootRef ?? internalRef}
        conversationId="conversation-1"
        pinnedToBottomRef={pinnedToBottomRef}
      >
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
  orderedIds = [];
});

const rowIds = (count: number) => Array.from({ length: count }, (_, index) => `m${index}`);

const manyRows = (count: number) => rowIds(count).map((id) => <Row key={id} messageId={id} />);

const isMounted = (messageId: string) => rowState.get(messageId)?.mounted === true;

const settleAll = () => flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);

const lastBatch = () => {
  const snapshot = api.getDiagnostics();
  return {
    displacement: snapshot.anchorDisplacement,
    correction: snapshot.anchorCorrection,
  };
};

/* -------------------------------------------------------------------------- */
/* The transaction                                                            */
/* -------------------------------------------------------------------------- */

describe('transition batch', () => {
  it('uses one flushSync for the whole batch', () => {
    // `jest.requireActual` returns the module instance the provider imported; a namespace
    // import would get an interop copy and the spy would never be called.
    const reactDom = jest.requireActual('react-dom');
    const flushSyncSpy = jest.spyOn(reactDom, 'flushSync');
    render(<Harness>{manyRows(2)}</Harness>);
    settleAll();
    scrollTo(3000);
    flushFrames(2);
    // one batch, one flushSync
    expect(flushSyncSpy).toHaveBeenCalledTimes(1);
    const batches = api.getDiagnostics().mountTransactionDurations.count;
    // one flushSync per recorded batch, never one per row
    expect(flushSyncSpy).toHaveBeenCalledTimes(batches);
    expect(batches).toBeGreaterThan(0);
    flushSyncSpy.mockRestore();
  });

  it('performs exactly one scroll write for a batch', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    scrollTo(4000);
    scrollWrites.length = 0;
    flushFrames(1);
    expect(scrollWrites.length).toBeLessThanOrEqual(1);
  });

  it('performs no write when the displacement is zero', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    // unmounting rows above the viewport whose placeholder height equals their real height
    // produces zero displacement, which is the expected steady state
    scrollTo(2500);
    scrollWrites.length = 0;
    flushFrames(2);
    expect(isMounted('m0')).toBe(false);
    const { displacement, correction } = lastBatch();
    expect(displacement.count).toBeGreaterThan(0);
    expect(displacement.total).toBe(0);
    expect(scrollWrites).toHaveLength(0);
    expect(correction.total).toBe(0);
  });

  it('does not correct for rows below the anchor', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    // the anchor is m0, intersecting the viewport at the top of the scroll range
    scrollTo(0);
    flushFrames(1);
    scrollWrites.length = 0;
    flushFrames(2);
    expect(api.getDiagnostics().anchorCorrection.total).toBe(0);
    expect(scrollWrites).toHaveLength(0);
  });

  it('applies one correction that matches the anchor displacement', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    // m0 is far above the viewport and becomes an 800 px placeholder
    scrollTo(2500);
    flushFrames(2);
    expect(isMounted('m0')).toBe(false);

    // while it was away its content grew. Remounting it at 1000 px pushes everything below
    // down by 200 px, so the anchor (m1, which intersects the viewport) moves by +200 and
    // that displacement must be corrected with exactly one write: 600 + 200 = 800.
    realHeights.set('m0', 1000);
    scrollTo(600);
    scrollWrites.length = 0;
    flushFrames(2);

    expect(isMounted('m0')).toBe(true);
    const { displacement, correction } = lastBatch();
    expect(displacement.max).toBe(200);
    expect(correction.max).toBe(200);
    expect(scrollWrites).toEqual([800]);
  });

  it('preserves the bottom instead of running top-anchor correction when pinned', () => {
    const pinnedToBottomRef = { current: true } as React.RefObject<boolean>;
    render(<Harness pinnedToBottomRef={pinnedToBottomRef}>{manyRows(3)}</Harness>);
    settleAll();
    scrollTopValue = 5000;
    scrollWrites.length = 0;
    const root = document.querySelector('.scroll-root') as HTMLElement;
    act(() => {
      root.dispatchEvent(new Event('scroll'));
    });
    flushFrames(2);
    // the only write is the absolute bottom clamp, never `scrollTop += displacement`
    expect(scrollWrites.length).toBeLessThanOrEqual(1);
    const displacement = api.getDiagnostics().anchorDisplacement;
    expect(displacement.total).toBe(0);
  });

  it('skips correction during an elastic overscroll', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();
    // above the natural top of the scroll range
    scrollTopValue = -80;
    const root = document.querySelector('.scroll-root') as HTMLElement;
    scrollWrites.length = 0;
    act(() => {
      root.dispatchEvent(new Event('scroll'));
    });
    flushFrames(2);
    expect(scrollWrites).toHaveLength(0);
  });

  it('owns overflow anchoring while mounted and restores it on unmount', () => {
    const { unmount } = render(<Harness>{manyRows(1)}</Harness>);
    const root = document.querySelector('.scroll-root') as HTMLElement;
    expect(root.style.overflowAnchor).toBe('none');
    unmount();
    expect(root.style.overflowAnchor).toBe('');
  });

  it('cancels queued frames and writes nothing after unmount', () => {
    const { unmount } = render(<Harness>{manyRows(3)}</Harness>);
    settleAll();
    scrollTo(4000);
    unmount();
    scrollWrites.length = 0;
    flushFrames(3);
    expect(scrollWrites).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Asynchronous resize corrections (§11.3)                                    */
/* -------------------------------------------------------------------------- */

describe('asynchronous resize correction', () => {
  const getResizeObserver = () => {
    const observer = MockResizeObserver.instances[0];
    if (!observer) {
      throw new Error('no resize observer was created');
    }
    return observer;
  };

  it('coalesces an asynchronous correction above the viewport into one write', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    // m0 is wholly above the viewport but inside the hysteresis band, so it stays mounted
    scrollTo(1000);
    flushFrames(2);
    expect(isMounted('m0')).toBe(true);
    const observer = getResizeObserver();
    const element = document.querySelector('[data-row-shell="m0"]')
      ?.firstElementChild as HTMLElement;
    scrollWrites.length = 0;
    observer.resize(element, ROW_HEIGHT + 40);
    observer.resize(element, ROW_HEIGHT + 80);
    flushFrames(1);
    expect(scrollWrites).toHaveLength(1);
    expect(api.getDiagnostics().asyncCorrection.count).toBe(1);
  });

  it('does not correct when the changed row is inside the viewport', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();
    const observer = getResizeObserver();
    const element = document.querySelector('[data-row-shell="m0"]')
      ?.firstElementChild as HTMLElement;
    // m0 intersects the viewport at scrollTop 0
    const rect = rectFor('m0');
    expect(rect.bottom).toBeGreaterThan(0);
    scrollWrites.length = 0;
    observer.resize(element, ROW_HEIGHT + 40);
    flushFrames(1);
    expect(scrollWrites).toHaveLength(0);
    expect(api.getDiagnostics().asyncCorrection.count).toBe(0);
  });

  it('does not correct while the reader is bottom-pinned', () => {
    const pinnedToBottomRef = { current: true } as React.RefObject<boolean>;
    render(<Harness pinnedToBottomRef={pinnedToBottomRef}>{manyRows(4)}</Harness>);
    settleAll();
    scrollTo(1000);
    flushFrames(2);
    const observer = getResizeObserver();
    const element = document.querySelector('[data-row-shell="m0"]')
      ?.firstElementChild as HTMLElement;
    scrollWrites.length = 0;
    observer.resize(element, ROW_HEIGHT + 40);
    flushFrames(1);
    expect(scrollWrites).toHaveLength(0);
    expect(api.getDiagnostics().asyncCorrection.count).toBe(0);
  });

  it('demotes a row and records a diagnostic when a correction exceeds the budget', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    scrollTo(1000);
    flushFrames(2);
    const observer = getResizeObserver();
    const element = document.querySelector('[data-row-shell="m0"]')
      ?.firstElementChild as HTMLElement;
    expect(isMounted('m0')).toBe(true);
    observer.resize(element, ROW_HEIGHT + MAX_EXPECTED_ACTIVE_SCROLL_CORRECTION_PX + 50);
    flushFrames(1);
    const snapshot = api.getDiagnostics();
    expect(snapshot.overBudgetCorrections).toBeGreaterThan(0);
    expect(snapshot.alwaysMountedRows).toBe(1);
  });

  it('does not correct below the minimum displacement', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();
    scrollTo(1000);
    flushFrames(2);
    const observer = getResizeObserver();
    const element = document.querySelector('[data-row-shell="m0"]')
      ?.firstElementChild as HTMLElement;
    scrollWrites.length = 0;
    observer.resize(element, ROW_HEIGHT + 0.2);
    flushFrames(1);
    expect(api.getDiagnostics().asyncCorrection.count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Batches and budgets                                                        */
/* -------------------------------------------------------------------------- */

describe('batch composition', () => {
  it('respects the unmount budget across the frames a batch may need', () => {
    render(<Harness>{manyRows(12)}</Harness>);
    settleAll();
    scrollTo(6000);
    flushFrames(4);
    const snapshot = api.getDiagnostics();
    expect(snapshot.unmountCountsPerFrame.max).toBeLessThanOrEqual(MAX_UNMOUNTS_PER_FRAME);
    expect(snapshot.unmountCountsPerFrame.total).toBeGreaterThan(0);
    expect(snapshot.placeholderRows).toBeGreaterThan(0);
  });

  it('converges: a settled viewport produces no further transitions', () => {
    render(<Harness>{manyRows(12)}</Harness>);
    settleAll();
    scrollTo(6000);
    flushFrames(4);
    const placeholders = api.getDiagnostics().placeholderRows;
    const batches = api.getDiagnostics().mountTransactionDurations.count;
    const writes = scrollWrites.length;
    // nothing changes in the layout, so further frames must not blink rows in and out
    flushFrames(6);
    const after = api.getDiagnostics();
    expect(after.placeholderRows).toBe(placeholders);
    expect(after.mountTransactionDurations.count).toBe(batches);
    expect(scrollWrites.length).toBe(writes);
  });

  it('records the batch id and duration', () => {
    render(<Harness>{manyRows(1)}</Harness>);
    settleAll();
    advanceClock(3);
    scrollTo(4000);
    flushFrames(1);
    expect(api.getDiagnostics().mountTransactionDurations.count).toBe(1);
  });
});

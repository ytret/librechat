import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import { classifyContentRow, isOversizedRowHeight } from '../contentRowPolicy';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import {
  CONTENT_ROW_QUIET_FRAMES,
  LARGE_ROW_HEIGHT_PX,
  type ContentRowKind,
  type ContentRowPolicy,
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
  MockIntersectionObserver.instances = [];
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
  // The Font Loading API being absent is what the provider treats as already ready, so
  // settlement here does not depend on microtask timing.
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
      if (!this.classList?.contains('scroll-root')) {
        return;
      }
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

/** Stack `count` rows far above the viewport, beyond the unmount hysteresis band. */
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
  kind,
  policy,
  measuredHeight,
  forceMounted = false,
  revision = 0,
}: {
  messageId: string;
  kind: ContentRowKind;
  policy: ContentRowPolicy;
  measuredHeight: number;
  forceMounted?: boolean;
  revision?: number;
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

  const fingerprint = composeFingerprint({ kind, sourceKey: revision });
  const debugKey = `${messageId}:${kind}:0`;

  // Mirrors `VirtualizedContentRow`: register once with the latest props, then publish every
  // change through `updateRow`, which is what decides whether a measurement is still valid.
  const latest = useRef({ messageId, kind, fingerprint, policy, forceMounted, debugKey });
  latest.current = { messageId, kind, fingerprint, policy, forceMounted, debugKey };

  useLayoutEffect(() => {
    const current = latest.current;
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId: current.messageId,
      debugKey: current.debugKey,
      kind: current.kind,
      fingerprint: current.fingerprint,
      policy: current.policy,
      forceMounted: current.forceMounted,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, generation: number, height?: number) =>
        setState({ mounted, generation, height }),
    });
  }, [windowing]);

  React.useEffect(() => {
    windowing.updateRow(token.current, { messageId, debugKey, fingerprint, policy, forceMounted });
  }, [windowing, messageId, debugKey, fingerprint, policy, forceMounted]);

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

beforeEach(() => {
  rowState.clear();
});

const placeholderRows = () => api.getDiagnostics().placeholderRows;
const oversizedRows = () => api.getDiagnostics().oversizedRows;
const isMounted = (messageId: string) => rowState.get(messageId)?.mounted === true;

/** Let every row settle so that it becomes unmount-eligible. */
function settleAll() {
  flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
}

/* -------------------------------------------------------------------------- */
/* Oversized demotion                                                         */
/* -------------------------------------------------------------------------- */

describe('large-row demotion', () => {
  it('never turns a row past the threshold into a placeholder', () => {
    const height = LARGE_ROW_HEIGHT_PX + 300;
    render(
      <Harness>
        <Row messageId="m0" kind="reasoning" policy="windowed" measuredHeight={height} />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);
    scrollBy(10);
    flushFrames(4);

    expect(placeholderRows()).toBe(0);
    expect(isMounted('m0')).toBe(true);
    expect(oversizedRows()).toBe(1);
  });

  it('retains the full measured height instead of capping it at the threshold', () => {
    const height = LARGE_ROW_HEIGHT_PX + 300;
    render(
      <Harness>
        <Row messageId="m0" kind="reasoning" policy="windowed" measuredHeight={height} />
      </Harness>,
    );
    settleAll();
    expect(api.getDiagnostics().measuredHeightDistribution.max).toBe(height);
  });

  it('leaves a row exactly at the threshold windowable', () => {
    render(
      <Harness>
        <Row
          messageId="m0"
          kind="reasoning"
          policy="windowed"
          measuredHeight={LARGE_ROW_HEIGHT_PX}
        />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);

    expect(placeholderRows()).toBe(1);
    expect(oversizedRows()).toBe(0);
    expect(isOversizedRowHeight(LARGE_ROW_HEIGHT_PX)).toBe(false);
  });

  it('re-evaluates the demotion when the source produces a new generation', () => {
    const { rerender } = render(
      <Harness>
        <Row
          messageId="m0"
          kind="reasoning"
          policy="windowed"
          measuredHeight={LARGE_ROW_HEIGHT_PX + 300}
        />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);
    expect(oversizedRows()).toBe(1);
    expect(placeholderRows()).toBe(0);

    rerender(
      <Harness>
        <Row messageId="m0" kind="reasoning" policy="windowed" revision={1} measuredHeight={300} />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);

    expect(oversizedRows()).toBe(0);
    expect(placeholderRows()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Unapproved content                                                         */
/* -------------------------------------------------------------------------- */

describe('content left unapproved by the classifier', () => {
  it('keeps unknown media mounted no matter where it sits', () => {
    const verdict = classifyContentRow({ type: ContentTypes.VIDEO_URL });
    render(
      <Harness>
        <Row
          messageId="m0"
          kind={verdict.kind}
          policy={verdict.policy}
          forceMounted={verdict.forceMounted}
          measuredHeight={300}
        />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);

    expect(verdict.policy).toBe('always-mounted');
    expect(placeholderRows()).toBe(0);
    expect(api.getDiagnostics().alwaysMountedRows).toBe(1);
  });

  it('keeps an image without stored dimensions mounted', () => {
    const verdict = classifyContentRow({ type: ContentTypes.IMAGE_FILE });
    render(
      <Harness>
        <Row
          messageId="m0"
          kind={verdict.kind}
          policy={verdict.policy}
          forceMounted={verdict.forceMounted}
          measuredHeight={300}
        />
      </Harness>,
    );
    settleAll();
    layoutBelowBand(1);
    scrollBy(10);
    flushFrames(4);

    expect(verdict.policy).toBe('always-mounted');
    expect(placeholderRows()).toBe(0);
  });
});

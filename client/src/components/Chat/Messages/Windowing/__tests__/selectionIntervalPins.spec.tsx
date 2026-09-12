import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';

/**
 * Stage 3 task 3.8 — selection interval pins (report 13 §6 Q8, spec §15.3).
 *
 * What is protected is an *existing* selection: every registered row in DOM order between the
 * anchor and focus of a non-collapsed selection cannot become a placeholder. Extending a selection
 * through content that is already a placeholder is Stage 5's directional materialization.
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
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  window.getSelection()?.removeAllRanges();
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
const rowState = new Map<string, { mounted: boolean; generation: number }>();

function Row({ messageId }: { messageId: string }) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const token = useRef(createRowToken(messageId));
  const scopeToken = useRef(createScopeToken());
  const [state, setState] = React.useState<{ mounted: boolean; generation: number }>({
    mounted: true,
    generation: 1,
  });
  rowState.set(messageId, state);

  useLayoutEffect(() => {
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId,
      debugKey: `${messageId}:reasoning:0`,
      kind: 'reasoning',
      fingerprint: composeFingerprint({ kind: 'reasoning', sourceKey: 0 }),
      policy: 'windowed',
      forceMounted: false,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, generation: number) => setState({ mounted, generation }),
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
      300,
      'layout-effect',
    );
    return unregister;
  }, [windowing, state.generation, state.mounted]);

  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef} data-row-shell={messageId}>
        {state.mounted ? (
          <div key={state.generation} ref={contentRef} data-testid={`content-${messageId}`}>
            <span>{`row ${messageId} selectable text`}</span>
          </div>
        ) : null}
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

const manyRows = (count: number) =>
  Array.from({ length: count }, (_, index) => <Row key={`m${index}`} messageId={`m${index}`} />);

const placeholderRows = () => api.getDiagnostics().placeholderRows;
const selectionPins = () => api.getDiagnostics().pinsByReason.selection;
const isMounted = (messageId: string) => rowState.get(messageId)?.mounted === true;

/** Let every row settle so that it becomes unmount-eligible. */
const settleAll = () => flushFrames(4);

/**
 * jsdom does not fire `selectionchange` when a range is added programmatically, so the tests
 * dispatch it themselves — which is also what makes the frame-coalescing assertions meaningful.
 */
const announceSelection = () => {
  document.dispatchEvent(new Event('selectionchange'));
};

const select = (fromMessageId: string, toMessageId: string) => {
  const range = document.createRange();
  range.setStartBefore(document.querySelector(`[data-testid="content-${fromMessageId}"]`)!);
  range.setEndAfter(document.querySelector(`[data-testid="content-${toMessageId}"]`)!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  announceSelection();
};

const collapseSelection = () => {
  window.getSelection()?.removeAllRanges();
  announceSelection();
};

const selectText = (messageId: string) => {
  const range = document.createRange();
  range.selectNodeContents(document.querySelector(`[data-testid="content-${messageId}"]`)!);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  announceSelection();
};

/* -------------------------------------------------------------------------- */
/* Existing selection                                                         */
/* -------------------------------------------------------------------------- */

describe('an existing selection', () => {
  it('pins every registered row between the anchor and focus', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();

    act(() => select('m1', 'm2'));
    flushFrames(1);

    expect(selectionPins()).toBe(2);
  });

  it('covers rows the selection only partly spans, since the row shells are what is pinned', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm2'));
    flushFrames(1);

    expect(selectionPins()).toBe(3);
  });

  it('pins the interval so those rows cannot become placeholders', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm1'));
    flushFrames(1);
    expect(selectionPins()).toBe(2);

    layoutBelowBand(3);
    scrollBy(10);
    flushFrames(4);

    // Only the row outside the interval is free to unmount.
    expect(placeholderRows()).toBe(1);
    expect(isMounted('m0')).toBe(true);
    expect(isMounted('m1')).toBe(true);
    expect(isMounted('m2')).toBe(false);
  });

  it('releases the pins when the selection collapses', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm1'));
    flushFrames(1);
    expect(selectionPins()).toBe(2);

    act(() => collapseSelection());
    flushFrames(1);
    expect(selectionPins()).toBe(0);
  });

  it('keeps the pins through a copy, which does not change the selection', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm2'));
    flushFrames(1);
    expect(selectionPins()).toBe(3);

    act(() => {
      document.dispatchEvent(new Event('copy'));
    });
    flushFrames(1);

    expect(selectionPins()).toBe(3);
  });

  it('narrows and widens with the selection instead of re-pinning from scratch', () => {
    render(<Harness>{manyRows(4)}</Harness>);
    settleAll();

    act(() => select('m0', 'm3'));
    flushFrames(1);
    expect(selectionPins()).toBe(4);

    act(() => select('m0', 'm1'));
    flushFrames(1);
    expect(selectionPins()).toBe(2);
  });

  it('pins nothing when the selection is entirely outside the rows', () => {
    render(<Harness>{manyRows(2)}</Harness>);
    settleAll();

    const outside = document.createElement('p');
    outside.textContent = 'outside the conversation';
    document.body.appendChild(outside);
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(outside);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    flushFrames(1);

    expect(selectionPins()).toBe(0);
    outside.remove();
  });

  it('releases the pins on unmount', () => {
    const { unmount } = render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm2'));
    flushFrames(1);
    expect(selectionPins()).toBe(3);

    unmount();
    expect(selectionPins()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Frame-time evaluation                                                      */
/* -------------------------------------------------------------------------- */

describe('evaluation at frame time', () => {
  it('evaluates at most once per animation frame however many events arrive', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => {
      select('m0', 'm1');
      // The helper already announced once; two more events must not schedule more work.
      announceSelection();
      announceSelection();
    });
    // The events themselves must not have pinned anything: they only schedule.
    expect(selectionPins()).toBe(0);

    flushFrames(1);
    expect(selectionPins()).toBe(2);
  });

  it('does not release when the event observes a momentarily collapsed selection', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm2'));
    flushFrames(1);
    expect(selectionPins()).toBe(3);

    // This is the shape of the hazard `useSelectionPreserve` creates during streaming: the
    // selection is cleared, an event is queued, and the range is re-added. Evaluating on the event
    // would see nothing selected and release; evaluating on the frame sees the restored range.
    act(() => {
      window.getSelection()!.removeAllRanges();
      announceSelection();
    });
    act(() => {
      const range = document.createRange();
      range.setStartBefore(document.querySelector('[data-testid="content-m0"]')!);
      range.setEndAfter(document.querySelector('[data-testid="content-m2"]')!);
      window.getSelection()!.addRange(range);
    });
    flushFrames(1);

    expect(selectionPins()).toBe(3);
  });

  it('leaves no pins behind for a frame that was already scheduled at unmount', () => {
    const { unmount } = render(<Harness>{manyRows(2)}</Harness>);
    settleAll();

    act(() => {
      select('m0', 'm1');
    });
    // The evaluation is scheduled but has not run; unmounting must both release what is held and
    // leave nothing for the pending callback to pin.
    unmount();
    expect(selectionPins()).toBe(0);

    flushFrames(2);
    expect(selectionPins()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Conversation change                                                        */
/* -------------------------------------------------------------------------- */

describe('a conversation change', () => {
  it('releases the previous conversation\u2019s interval pins', () => {
    const { rerender } = render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm2'));
    flushFrames(1);
    expect(selectionPins()).toBe(3);

    rerender(<Harness conversationId="conversation-2">{manyRows(3)}</Harness>);
    flushFrames(1);

    expect(selectionPins()).toBe(0);
  });

  it('re-pins for the new conversation when the selection still spans its rows', () => {
    const { rerender } = render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => select('m0', 'm1'));
    flushFrames(1);
    expect(selectionPins()).toBe(2);

    rerender(<Harness conversationId="conversation-2">{manyRows(3)}</Harness>);
    flushFrames(1);

    // A non-collapsed selection is still protected after the switch; it is the same DOM interval.
    act(() => select('m0', 'm1'));
    flushFrames(1);
    expect(selectionPins()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Selecting within one row                                                   */
/* -------------------------------------------------------------------------- */

describe('a selection inside a single row', () => {
  it('pins that row', () => {
    render(<Harness>{manyRows(3)}</Harness>);
    settleAll();

    act(() => selectText('m1'));
    flushFrames(1);

    expect(selectionPins()).toBe(1);
  });
});

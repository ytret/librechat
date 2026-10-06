import React, { useRef } from 'react';
import { RecoilRoot } from 'recoil';
import { act, fireEvent, render } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { CONTENT_ROW_QUIET_FRAMES, LARGE_ROW_HEIGHT_PX } from '../contentRowTypes';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';
import ContentParts from '../../Content/ContentParts';

/**
 * Stage 3 task 3.9 (supervisor decision D8.5) — expansion state survives a **real** row
 * unmount/remount.
 *
 * The 3.2 and 3.3 tests remove and restore the *parts* while the owner stays mounted. This file
 * drives the whole path instead: a provider, `ContentParts` as the lifted owner, and the real
 * `VirtualizedContentRow` beneath it, so the row settles, becomes a placeholder, is scrolled back
 * into range, and remounts through a new generation. Only then is the §19 gate item "no state loss
 * after unmount/remount" measured against the mechanism that actually unmounts rows.
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

const rootRect: Rect = { top: 0, bottom: 500 };
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

/** The measured inner element must report a real height, or the row has nothing to reserve. */
const placeRow = (key: string, rect: Rect) => {
  const shell = document.querySelector(`[data-content-row-key="${key}"]`);
  if (!shell) {
    throw new Error(`no row shell for ${key}`);
  }
  rects.set(shell, rect);
  const measured = shell.querySelector('.content-virtual-row__measured');
  if (measured) {
    rects.set(measured, { top: rect.top, bottom: rect.bottom });
  }
};

const inView = (key: string, top = 100) => placeRow(key, { top, bottom: top + 300 });
const farAbove = (key: string) => placeRow(key, { top: -5000, bottom: -4700 });

const scrollBy = (delta: number) => {
  scrollTopValue += delta;
  const root = document.querySelector('.scroll-root');
  act(() => {
    root?.dispatchEvent(new Event('scroll'));
  });
};

const settle = () => flushFrames(CONTENT_ROW_QUIET_FRAMES + 2);

/**
 * Finish the expansion transition the way the browser does.
 *
 * jsdom runs no transitions, so the `transitionend` that releases the expansion pin never arrives
 * on its own and the pin stays held. That matters here: a held pin stops the row from settling, so
 * it can never become a placeholder, and this suite is about the placeholder cycle. It used to pass
 * without this step because the row was remounted whenever the expansion state changed, and the
 * pin's hook releases on unmount — the row unmounted mid-animation, which is the behaviour that was
 * fixed. Dispatching the event is the primary release path the pin documents; the 400 ms fallback
 * is for the case where no transition event ever arrives at all.
 */
const finishExpansionTransition = () => {
  const element = document.querySelector('[role="group"], [role="region"]');
  if (!element) {
    return;
  }
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'grid-template-rows' });
  act(() => {
    element.dispatchEvent(event);
  });
};

/** Settle, then push the row out of range so it becomes a placeholder. */
const scrollRowAway = (key: string) => {
  settle();
  farAbove(key);
  scrollBy(10);
  flushFrames(4);
};

/** As `scrollRowAway`, for a row whose expansion transition is still in flight here. */
const scrollExpandedRowAway = (key: string) => {
  finishExpansionTransition();
  scrollRowAway(key);
};

/** Bring the row back into range and let it remount. */
const scrollRowBack = (key: string) => {
  inView(key);
  scrollBy(-10);
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

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useProgress: (initial: number) => initial,
  scheduleMessageContentLayoutReconcile: jest.fn(() => jest.fn()),
}));

jest.mock('~/hooks/MCP', () => ({ useMCPIconMap: () => new Map() }));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
  Clipboard: () => <span />,
  CheckMark: () => <span />,
  Skeleton: () => <span />,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

jest.mock('../../Content/Parts/useLazyHighlight', () => ({
  __esModule: true,
  default: () => null,
}));

const think = (body: string): TMessageContentParts =>
  ({ type: ContentTypes.THINK, think: body, thinkDuration: 1200 }) as TMessageContentParts;

const summary = (): TMessageContentParts =>
  ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'condensed history' }],
    model: 'gpt-4o',
    provider: 'openai',
    tokenCount: 12,
    summarizing: false,
  }) as unknown as TMessageContentParts;

function Harness({ content }: { content: Array<TMessageContentParts | undefined> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="scroll-root">
      <ContentRowWindowingProvider scrollRootRef={scrollRef} conversationId="conversation-1">
        <Probe />
        <ContentParts
          content={content}
          messageId="m1"
          isCreatedByUser={false}
          isLast
          isSubmitting={false}
        />
      </ContentRowWindowingProvider>
    </div>
  );
}

const renderTree = (content: Array<TMessageContentParts | undefined>) => {
  const result = render(
    <RecoilRoot>
      <Harness content={content} />
    </RecoilRoot>,
  );
  flushFrames(4);
  return result;
};

const rowShell = (key: string) =>
  document.querySelector(`[data-content-row-key="${key}"]`) as HTMLElement | null;
const isPlaceholder = (key: string) =>
  rowShell(key)?.getAttribute('data-content-mounted') === 'false';

const toggleIn = (key: string): HTMLButtonElement => {
  const button = rowShell(key)?.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!button) {
    throw new Error(`no toggle inside ${key}`);
  }
  return button;
};

/** The generation increments on every remount, which is what makes it a new element. */
const generationOf = (key: string) =>
  Number(rowShell(key)?.getAttribute('data-content-generation'));

/* -------------------------------------------------------------------------- */
/* Reasoning                                                                  */
/* -------------------------------------------------------------------------- */

describe('reasoning expansion across a real placeholder cycle', () => {
  it('restores the expanded state after the row unmounts and remounts', () => {
    renderTree([think('a reasoning body')]);
    const key = 'm1:reasoning:0';

    expect(isPlaceholder(key)).toBe(false);
    fireEvent.click(toggleIn(key));
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');

    scrollExpandedRowAway(key);
    expect(isPlaceholder(key)).toBe(true);
    // The row's contents really are gone: this is the unmount the gate item is about.
    expect(rowShell(key)?.querySelector('button[aria-expanded]')).toBeNull();
    expect(api.getDiagnostics().placeholderRows).toBe(1);

    const before = generationOf(key);
    scrollRowBack(key);

    expect(isPlaceholder(key)).toBe(false);
    expect(generationOf(key)).toBeGreaterThan(before);
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');
  });

  it('restores the collapsed state after a placeholder cycle', () => {
    renderTree([think('a reasoning body')]);
    const key = 'm1:reasoning:0';

    fireEvent.click(toggleIn(key));
    fireEvent.click(toggleIn(key));
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('false');

    scrollExpandedRowAway(key);
    expect(isPlaceholder(key)).toBe(true);
    scrollRowBack(key);

    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps two reasoning rows independent across their own cycles', () => {
    renderTree([think('first body'), think('second body')]);
    const first = 'm1:reasoning:0';
    const second = 'm1:reasoning:1';

    fireEvent.click(toggleIn(first));
    expect(toggleIn(first).getAttribute('aria-expanded')).toBe('true');
    expect(toggleIn(second).getAttribute('aria-expanded')).toBe('false');

    scrollExpandedRowAway(first);
    scrollRowAway(second);
    expect(isPlaceholder(first)).toBe(true);
    expect(isPlaceholder(second)).toBe(true);

    scrollRowBack(first);
    scrollRowBack(second);

    expect(toggleIn(first).getAttribute('aria-expanded')).toBe('true');
    expect(toggleIn(second).getAttribute('aria-expanded')).toBe('false');
  });
});

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

describe('summary expansion across a real placeholder cycle', () => {
  it('restores the expanded state after the row unmounts and remounts', () => {
    renderTree([summary()]);
    const key = 'm1:summary:0';

    fireEvent.click(toggleIn(key));
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');

    scrollExpandedRowAway(key);
    expect(isPlaceholder(key)).toBe(true);
    expect(rowShell(key)?.querySelector('button[aria-expanded]')).toBeNull();

    const before = generationOf(key);
    scrollRowBack(key);

    expect(isPlaceholder(key)).toBe(false);
    expect(generationOf(key)).toBeGreaterThan(before);
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves a summary collapsed across a placeholder cycle when it was never opened', () => {
    renderTree([summary()]);
    const key = 'm1:summary:0';

    scrollRowAway(key);
    expect(isPlaceholder(key)).toBe(true);
    scrollRowBack(key);

    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('false');
  });
});

/* -------------------------------------------------------------------------- */
/* Repeated cycles                                                            */
/* -------------------------------------------------------------------------- */

describe('repeated placeholder cycles', () => {
  it('holds the expansion state across two cycles, not only the first', () => {
    renderTree([think('a reasoning body')]);
    const key = 'm1:reasoning:0';

    fireEvent.click(toggleIn(key));
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');

    scrollExpandedRowAway(key);
    expect(isPlaceholder(key)).toBe(true);
    scrollRowBack(key);
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');

    // A second cycle: each remount is a new generation, so this checks that the owner's state is
    // what supplies the value rather than anything the first remount happened to leave behind.
    // No transition is in flight here — this pass expands nothing, so no pin is held.
    scrollRowAway(key);
    expect(isPlaceholder(key)).toBe(true);
    scrollRowBack(key);
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');
  });

  it('does not revive a state that was collapsed again after a remount', () => {
    renderTree([think('a reasoning body')]);
    const key = 'm1:reasoning:0';

    fireEvent.click(toggleIn(key));
    scrollRowAway(key);
    scrollRowBack(key);
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(toggleIn(key));
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('false');

    scrollRowAway(key);
    scrollRowBack(key);
    expect(toggleIn(key).getAttribute('aria-expanded')).toBe('false');
  });
});

/* -------------------------------------------------------------------------- */
/* The oversized rule is not what these tests trip                            */
/* -------------------------------------------------------------------------- */

describe('height regime', () => {
  it('keeps every row in these tests well under the large-row threshold', () => {
    renderTree([think('a reasoning body')]);
    const height = api.getDiagnostics().measuredHeightDistribution.max ?? 0;

    expect(height).toBeLessThan(LARGE_ROW_HEIGHT_PX);
    expect(api.getDiagnostics().oversizedRows).toBe(0);
  });
});

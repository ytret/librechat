import React, { useRef } from 'react';
import { RecoilRoot } from 'recoil';
import { act, render } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { ContentRowWindowingProvider } from '../ContentRowWindowingContext';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { CONTENT_ROW_QUIET_FRAMES } from '../contentRowTypes';
import ContentParts from '../../Content/ContentParts';

/**
 * A row whose content is replaced must not keep a height measured for what used to be there.
 *
 * The row fingerprint decides whether a previous measurement still describes what is rendered
 * (§12 rule 6, §14). Expansion state is in it, and the source key is in it, but the *content* was
 * not: no production caller supplied `contentKey`, so two different contents at the same message
 * and index produced the same fingerprint. `canRowUnmount` compares the fingerprint captured with
 * the measurement against the row's current one, so the old height stayed valid — and a placeholder
 * left off-screen went on reserving the old content's height until it was scrolled back into view.
 *
 * Driven through `ContentParts`, because the missing wiring is in the caller, not in the row: a
 * test that hands `contentKey` to `VirtualizedContentRow` directly would pass without the fix.
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

/**
 * A real observer fires straight after `observe` with the element's current size. jsdom never
 * does, so the callback is captured here and fired explicitly by `fireResize`, or a row would
 * never record a height and the placeholder below would reserve nothing.
 */
let resizeCallbacks: ResizeObserverCallback[] = [];
class MockResizeObserver {
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: ResizeObserverCallback) {
    resizeCallbacks.push(callback);
  }
}

/** Report every currently positioned element's height, the way a browser would after layout. */
const fireResize = () => {
  const entries = Array.from(rects.entries()).map(([target, rect]) => ({
    target,
    contentRect: { height: rect.bottom - rect.top } as DOMRectReadOnly,
    borderBoxSize: [{ blockSize: rect.bottom - rect.top }],
  })) as unknown as ResizeObserverEntry[];
  act(() => {
    resizeCallbacks.forEach((callback) => callback(entries, {} as ResizeObserver));
  });
};

let clock = 0;
const originalNow = performance.now;

beforeEach(() => {
  frameQueue = [];
  clock = 0;
  resizeCallbacks = [];
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

/**
 * The row key is `messageId:kind:ordinal`; these tests render exactly one row at a time, and the
 * kind differs per content type, so the shell is found by its row attribute rather than by key.
 */
const rowShell = () => document.querySelector('[data-content-virtual-row="true"]') as HTMLElement;
const isPlaceholder = () => rowShell()?.getAttribute('data-content-mounted') === 'false';
const rowGeneration = () => Number(rowShell()?.getAttribute('data-content-generation'));
/** The height a placeholder reserves, in px, as the inline style actually applies it. */
const reservedHeight = () => parseFloat(rowShell()?.style.height ?? '0');

/** Position the row shell and its measured element; this is the height the row will record. */
const placeRow = (rect: Rect) => {
  const shell = rowShell();
  if (!shell) {
    throw new Error('no row shell');
  }
  rects.set(shell, rect);
  const measured = shell.querySelector('.content-virtual-row__measured');
  if (measured) {
    rects.set(measured, { top: rect.top, bottom: rect.bottom });
  }
};

const inView = (top = 100) => placeRow({ top, bottom: top + 300 });
const farAbove = () => placeRow({ top: -5000, bottom: -4700 });

const scrollBy = (delta: number) => {
  scrollTopValue += delta;
  const root = document.querySelector('.scroll-root');
  act(() => {
    root?.dispatchEvent(new Event('scroll'));
  });
};

const settle = () => flushFrames(CONTENT_ROW_QUIET_FRAMES + 2);

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

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

function Harness({ content }: { content: Array<TMessageContentParts | undefined> }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="scroll-root">
      <ContentRowWindowingProvider scrollRootRef={scrollRef} conversationId="conversation-1">
        <ContentParts
          content={content}
          messageId="m1"
          isCreatedByUser={false}
          isLast={false}
          isSubmitting={false}
        />
      </ContentRowWindowingProvider>
    </div>
  );
}

const errorPart = (error: string): TMessageContentParts =>
  ({ type: ContentTypes.ERROR, error }) as unknown as TMessageContentParts;

/**
 * An error part with no `error` field. `Content/Part.tsx` renders
 * `part.error ?? part.text ?? part.text?.value`, so this still shows text — the fallback the
 * fingerprint originally ignored.
 */
const errorWithText = (text: string): TMessageContentParts =>
  ({ type: ContentTypes.ERROR, text }) as unknown as TMessageContentParts;

/**
 * A reasoning part in the `TextData` form. `Part.tsx` resolves
 * `typeof part.think === 'string' ? part.think : part.think?.value`, so this renders normally.
 */
const thinkWithValue = (value: string): TMessageContentParts =>
  ({
    type: ContentTypes.THINK,
    think: { value },
    thinkDuration: 1200,
  }) as unknown as TMessageContentParts;

/** A summary whose body is fixed and whose metadata line is not: `Parts/Summary.tsx` draws both. */
const summaryPart = (meta: {
  provider?: string;
  model?: string;
  tokenCount?: number;
}): TMessageContentParts =>
  ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'unchanged summary body' }],
    summarizing: false,
    ...meta,
  }) as unknown as TMessageContentParts;

const renderTree = (content: Array<TMessageContentParts | undefined>) => {
  const result = render(
    <RecoilRoot>
      <Harness content={content} />
    </RecoilRoot>,
  );
  flushFrames(4);
  return result;
};

describe('a row whose content is replaced at the same index', () => {
  it('does not keep the old height in the placeholder it leaves behind', () => {
    const { rerender } = renderTree([errorPart('a short failure')]);

    inView();
    fireResize();
    settle();
    expect(rowGeneration()).toBe(1);

    // Off screen, so the row is a placeholder reserving the height just measured.
    farAbove();
    scrollBy(10);
    flushFrames(4);
    expect(isPlaceholder()).toBe(true);
    const before = reservedHeight();
    expect(before).toBeGreaterThan(0);

    // The same message and the same index now render different content, and it is taller.
    farAbove();
    rerender(
      <RecoilRoot>
        <Harness content={[errorPart('a considerably longer failure message')]} />
      </RecoilRoot>,
    );
    flushFrames(1);
    // The replacement is taller than what came before: 450px against the 300px measured above.
    placeRow({ top: -5000, bottom: -4550 });
    fireResize();
    settle();
    flushFrames(4);

    expect(rowGeneration()).toBeGreaterThan(1);
    expect(reservedHeight()).not.toBe(before);
    expect(reservedHeight()).toBe(450);
  });

  it('re-measures when the reasoning text changes in the `{ value }` form the type allows', () => {
    const { rerender } = renderTree([thinkWithValue('a short thought')]);

    inView();
    fireResize();
    settle();
    farAbove();
    scrollBy(10);
    flushFrames(4);
    expect(isPlaceholder()).toBe(true);
    const before = reservedHeight();

    farAbove();
    rerender(
      <RecoilRoot>
        <Harness content={[thinkWithValue('a considerably longer thought than before')]} />
      </RecoilRoot>,
    );
    flushFrames(1);
    placeRow({ top: -5000, bottom: -4550 });
    fireResize();
    settle();
    flushFrames(4);

    expect(rowGeneration()).toBeGreaterThan(1);
    expect(reservedHeight()).not.toBe(before);
    expect(reservedHeight()).toBe(450);
  });

  it('re-measures when the error text changes through the field the renderer falls back to', () => {
    const { rerender } = renderTree([errorWithText('a short failure')]);

    inView();
    fireResize();
    settle();
    farAbove();
    scrollBy(10);
    flushFrames(4);
    expect(isPlaceholder()).toBe(true);
    const before = reservedHeight();

    farAbove();
    rerender(
      <RecoilRoot>
        <Harness content={[errorWithText('a considerably longer failure message')]} />
      </RecoilRoot>,
    );
    flushFrames(1);
    placeRow({ top: -5000, bottom: -4550 });
    fireResize();
    settle();
    flushFrames(4);

    expect(rowGeneration()).toBeGreaterThan(1);
    expect(reservedHeight()).not.toBe(before);
    expect(reservedHeight()).toBe(450);
  });

  it('re-measures when only the summary metadata changes, not its body', () => {
    const { rerender } = renderTree([
      summaryPart({ provider: 'openai', model: 'gpt-4o', tokenCount: 12 }),
    ]);

    inView();
    fireResize();
    settle();
    farAbove();
    scrollBy(10);
    flushFrames(4);
    expect(isPlaceholder()).toBe(true);
    const before = reservedHeight();

    farAbove();
    rerender(
      <RecoilRoot>
        <Harness
          content={[
            summaryPart({
              provider: 'anthropic',
              model: 'claude-sonnet-4-5-20250929-with-a-long-name',
              tokenCount: 987654,
            }),
          ]}
        />
      </RecoilRoot>,
    );
    flushFrames(1);
    placeRow({ top: -5000, bottom: -4550 });
    fireResize();
    settle();
    flushFrames(4);

    expect(rowGeneration()).toBeGreaterThan(1);
    expect(reservedHeight()).not.toBe(before);
    expect(reservedHeight()).toBe(450);
  });

  it('keeps the height when the content did not change, so the check above is not a rerender', () => {
    const { rerender } = renderTree([errorPart('a short failure')]);

    inView();
    settle();

    farAbove();
    scrollBy(10);
    flushFrames(4);
    expect(isPlaceholder()).toBe(true);
    const before = reservedHeight();

    // Same content, new object identity: this alone must not disturb the measurement.
    farAbove();
    rerender(
      <RecoilRoot>
        <Harness content={[errorPart('a short failure')]} />
      </RecoilRoot>,
    );
    settle();
    flushFrames(4);

    expect(reservedHeight()).toBe(before);
  });
});

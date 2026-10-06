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
import { CONTENT_ROW_QUIET_FRAMES } from '../contentRowTypes';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';
import ContentParts from '../../Content/ContentParts';

/**
 * Regression test for the expansion defect found after Stage 3's acceptance run and reproduced in
 * Safari on `v0.8.7+ytret14` (2026-10-05).
 *
 * Expanding a thought or summary row must not replace the row's subtree. The element that carries
 * the `grid-template-rows` transition has to survive the state change, or there is nothing to
 * animate from, the toggle button the user just activated is destroyed, and the pin that was taken
 * for the animation is released by the unmount before the transition can run.
 *
 * `expansionTransitionPinWiring.spec.tsx` does not cover this: it supplies a hand-written
 * `ContentRowInteractionProvider` and renders `Reasoning` on its own, so no `VirtualizedContentRow`
 * and no fingerprint-driven generation change exist to observe. This file uses the **real** provider
 * and the real row wrapper, reached through `ContentParts`, which is where the expansion state is
 * lifted.
 */

const originalRAF = global.requestAnimationFrame;
const originalCAF = global.cancelAnimationFrame;
const originalIO = global.IntersectionObserver;
const originalRO = global.ResizeObserver;

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

let frameQueue: FrameRequestCallback[] = [];
const originalNow = performance.now;

/** Frames are queued, never run inline: the settlement loop reschedules itself and a synchronous
 *  `requestAnimationFrame` would recurse until the stack overflows. */
const flushFrames = (count = 1) => {
  for (let index = 0; index < count; index++) {
    const queue = frameQueue;
    frameQueue = [];
    act(() => {
      queue.forEach((callback) => callback(0));
    });
  }
};

beforeEach(() => {
  frameQueue = [];
  jest.spyOn(performance, 'now').mockImplementation(() => 0);
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
  performance.now = originalNow;
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  resetContentRowWindowingEnabledForTests();
  window.localStorage.clear();
});

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

let api: ContentRowWindowingRuntime;

function Probe() {
  api = useContentRowWindowing();
  return null;
}

function Harness({ children }: { children: React.ReactNode }) {
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

const renderParts = (content: Array<TMessageContentParts | undefined>) => {
  const result = render(
    <RecoilRoot>
      <Harness>
        <ContentParts
          content={content}
          messageId="m1"
          isCreatedByUser={false}
          isLast
          isSubmitting={false}
        />
      </Harness>
    </RecoilRoot>,
  );
  flushFrames(4);
  return result;
};

const think = (thinkText: string, thinkDuration?: number): TMessageContentParts =>
  ({ type: ContentTypes.THINK, think: thinkText, thinkDuration }) as TMessageContentParts;

const summary = (): TMessageContentParts =>
  ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'condensed' }],
    model: 'gpt-4o',
    provider: 'openai',
    tokenCount: 3,
    summarizing: false,
  }) as unknown as TMessageContentParts;

const rowShell = () =>
  document.querySelector('[data-content-virtual-row="true"]') as HTMLElement | null;

const rowGeneration = () => rowShell()?.getAttribute('data-content-generation');

const toggle = (group: 'reasoning' | 'summary') =>
  document
    .querySelector(`.group\\/${group}`)
    ?.querySelector<HTMLButtonElement>('button[aria-expanded]') as HTMLButtonElement;

/** The element that carries the `grid-template-rows` transition, per `useExpandCollapse`. */
const expandingElement = (role: 'group' | 'region') =>
  document.querySelector(`[role="${role}"]`) as HTMLElement | null;

/**
 * Finish the expansion transition the way the browser does, then let the row settle.
 *
 * jsdom runs no transitions, so the `transitionend` that releases the expansion pin never arrives
 * on its own. Completing it is what makes each toggle a *finished* expand/collapse rather than an
 * interrupted one — which is the situation the budget below is being asked about.
 */
const finishTransition = () => {
  const element = expandingElement('group') ?? expandingElement('region');
  if (!element) {
    return;
  }
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'grid-template-rows' });
  act(() => {
    element.dispatchEvent(event);
  });
};

const settle = () => flushFrames(CONTENT_ROW_QUIET_FRAMES + 2);

/**
 * Toggle a row `times` times, completing the transition and settling between each one.
 *
 * This is ordinary reading: a reader who expands a thought, reads it, collapses it, and does the
 * same again a few times. Nothing here is uncontrolled resizing.
 */
const toggleCompleted = (group: 'reasoning' | 'summary', times: number) => {
  for (let index = 0; index < times; index++) {
    const button = toggle(group);
    if (!button) {
      throw new Error(`no ${group} toggle for pass ${index + 1}`);
    }
    fireEvent.click(button);
    finishTransition();
    settle();
  }
};

describe('expanding a row under windowing', () => {
  it('keeps the row generation, so the animating element survives the expansion', () => {
    renderParts([think('a reasoning body', 1200)]);
    expect(rowGeneration()).toBe('1');

    const before = expandingElement('group');
    expect(before).not.toBeNull();

    fireEvent.click(toggle('reasoning'));

    expect(rowGeneration()).toBe('1');
    expect(expandingElement('group')).toBe(before);
  });

  it('keeps keyboard focus on the toggle the user activated', () => {
    renderParts([think('a reasoning body', 1200)]);
    const button = toggle('reasoning');
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    expect(document.activeElement).toBe(toggle('reasoning'));
  });

  it('holds the animation pin for the duration of the expansion, not zero frames', () => {
    renderParts([think('a reasoning body', 1200)]);
    expect(api.getDiagnostics().pinsByReason.animation).toBe(0);

    fireEvent.click(toggle('reasoning'));

    expect(api.getDiagnostics().pinsByReason.animation).toBe(1);
  });

  it('behaves the same way for a summary row', () => {
    renderParts([summary()]);

    const before = expandingElement('region');
    const button = toggle('summary');
    button.focus();
    fireEvent.click(button);

    expect(rowGeneration()).toBe('1');
    expect(expandingElement('region')).toBe(before);
    expect(document.activeElement).toBe(toggle('summary'));
  });
});

/**
 * Repeated expansion must not consume the settlement budget.
 *
 * `MAX_SETTLEMENT_ATTEMPTS` exists to bound *uncontrolled* resizing: a row that settles and then
 * re-unsettles, forever, with no single budget ever elapsing. A deliberate expand/collapse is not
 * that — the reader asked for it, and the row settles again afterwards. But the in-place re-measure
 * this fix introduced routed through the same attempt counter, which is never cleared by settling,
 * so ordinary use demoted the row to `always-mounted` and permanently switched windowing off for
 * it. Measured before the fix: `alwaysMountedRows: 1`, reason `too-many-attempts`, `attempts: 4`
 * after the third completed toggle (mount holds attempt 1).
 */
describe('repeated expansion does not exhaust the settlement budget', () => {
  it('keeps a reasoning row windowable after four completed toggles', () => {
    renderParts([think('a bounded reasoning body', 1200)]);

    toggleCompleted('reasoning', 4);

    const diagnostics = api.getDiagnostics();
    expect(diagnostics.settlementTimeoutDetails).toEqual([]);
    expect(diagnostics.settlementTimeouts).toBe(0);
    expect(diagnostics.alwaysMountedRows).toBe(0);
    // Windowing is still in force for this row, so the fix did not merely hide the demotion.
    expect(diagnostics.oversizedRows).toBe(0);
    expect(diagnostics.pinsByReason.animation).toBe(0);
  });

  it('keeps a summary row windowable after four completed toggles', () => {
    renderParts([summary()]);

    toggleCompleted('summary', 4);

    const diagnostics = api.getDiagnostics();
    expect(diagnostics.settlementTimeoutDetails).toEqual([]);
    expect(diagnostics.settlementTimeouts).toBe(0);
    expect(diagnostics.alwaysMountedRows).toBe(0);
    expect(diagnostics.oversizedRows).toBe(0);
    expect(diagnostics.pinsByReason.animation).toBe(0);
  });
});

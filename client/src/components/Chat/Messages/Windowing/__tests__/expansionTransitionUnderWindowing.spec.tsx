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

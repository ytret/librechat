import React, { useRef } from 'react';
import { RecoilRoot } from 'recoil';
import { act, render } from '@testing-library/react';
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
 * Stage 3 task 3.6 — which content parts actually become rows (report 13 §6 Q1).
 *
 * The classifier decides, not the renderer: reasoning, summary, a known-size image, and a finalized
 * error become rows; markdown, tools, and anything inside a parallel section render exactly as they
 * did before, with no virtual-row attributes and no registration.
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

/**
 * Stubbed because the real renderer pulls in branch-mutation hooks and a query client that have
 * nothing to do with row wrapping. What matters here is that `ContentParts` hands every part of a
 * parallel message through the same `renderPart`, and that `renderPart` leaves a part with a
 * `groupId` unwrapped.
 */
jest.mock('../../Content/ParallelContent', () => ({
  ParallelContentRenderer: ({
    content,
    renderPart,
  }: {
    content: TMessageContentParts[];
    renderPart: (part: TMessageContentParts, idx: number, isLast: boolean) => React.ReactNode;
  }) => <>{content.map((part, idx) => renderPart(part, idx, idx === content.length - 1))}</>,
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

const rowShells = () =>
  Array.from(document.querySelectorAll('[data-content-virtual-row="true"]')).map((element) =>
    element.getAttribute('data-content-row-key'),
  );

const renderParts = (
  content: Array<TMessageContentParts | undefined>,
  extra: Partial<React.ComponentProps<typeof ContentParts>> = {},
) => {
  const result = render(
    <RecoilRoot>
      <Harness>
        <ContentParts
          content={content}
          messageId="m1"
          isCreatedByUser={false}
          isLast
          isSubmitting={false}
          {...extra}
        />
      </Harness>
    </RecoilRoot>,
  );
  flushFrames(4);
  return result;
};

const think = (thinkText: string, thinkDuration?: number): TMessageContentParts =>
  ({ type: ContentTypes.THINK, think: thinkText, thinkDuration }) as TMessageContentParts;

const summary = (summarizing = false): TMessageContentParts =>
  ({
    type: ContentTypes.SUMMARY,
    content: [{ type: ContentTypes.TEXT, text: 'condensed' }],
    model: 'gpt-4o',
    provider: 'openai',
    tokenCount: 3,
    summarizing,
  }) as unknown as TMessageContentParts;

const error = (): TMessageContentParts =>
  ({ type: ContentTypes.ERROR, error: 'something went wrong' }) as unknown as TMessageContentParts;

const text = (value: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;

const image = (dims?: { width: number; height: number }): TMessageContentParts =>
  ({
    type: ContentTypes.IMAGE_FILE,
    image_file: {
      filepath: '/images/test.png',
      filename: 'test.png',
      ...(dims ?? {}),
    },
  }) as unknown as TMessageContentParts;

const toolCall = (): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: 't1',
      name: 'bash_tool',
      args: JSON.stringify({ command: 'ls' }),
      output: 'ok',
    },
  }) as unknown as TMessageContentParts;

describe('which parts become rows', () => {
  it('wraps completed reasoning', () => {
    renderParts([think('a body', 1200)]);
    expect(rowShells()).toEqual(['m1:reasoning:0']);
  });

  it('wraps a summary', () => {
    renderParts([summary()]);
    expect(rowShells()).toEqual(['m1:summary:0']);
  });

  it('wraps a finalized error as the generic immutable kind', () => {
    renderParts([error()]);
    expect(rowShells()).toEqual(['m1:generic:0']);
  });

  it('wraps an image that has stored dimensions', () => {
    renderParts([image({ width: 800, height: 600 })]);
    expect(rowShells()).toEqual(['m1:image:0']);
  });

  it('leaves markdown, tools, and dimension-less images unwrapped', () => {
    renderParts([text('prose'), toolCall(), image()]);
    expect(rowShells()).toEqual([]);
    expect(api.getDiagnostics().registeredRows).toBe(0);
  });

  it('leaves a part inside a parallel section unwrapped', () => {
    const parallel = {
      ...(think('a body', 1200) as unknown as Record<string, unknown>),
      groupId: 'g1',
    } as unknown as TMessageContentParts;
    renderParts([parallel]);
    expect(rowShells()).toEqual([]);
  });

  it('wraps every approved part in one message, each with its own row', () => {
    renderParts([think('a body', 1200), text('prose'), summary(), think('another', 900)]);
    expect(rowShells()).toEqual(['m1:reasoning:0', 'm1:summary:2', 'm1:reasoning:3']);
  });
});

describe('streaming parts', () => {
  it('force-mounts a reasoning row that is still streaming', () => {
    renderParts([think('partial')], { isSubmitting: true, isLatestMessage: true });
    expect(rowShells()).toEqual(['m1:reasoning:0']);
    expect(api.getDiagnostics().forcedRows).toBe(1);
  });

  it('does not force-mount a completed reasoning row', () => {
    renderParts([think('a body', 1200)], { isSubmitting: true, isLatestMessage: true });
    expect(api.getDiagnostics().forcedRows).toBe(0);
  });

  it('does not force-mount an image row, whose in-flight state is its load', () => {
    renderParts([image({ width: 800, height: 600 })], {
      isSubmitting: true,
      isLatestMessage: true,
    });
    expect(rowShells()).toEqual(['m1:image:0']);
    expect(api.getDiagnostics().forcedRows).toBe(0);
  });

  it('treats a summarizing summary as in flight', () => {
    renderParts([summary(true)], { isSubmitting: true, isLatestMessage: true });
    expect(api.getDiagnostics().forcedRows).toBe(1);
  });
});

describe('with the flag off', () => {
  it('renders content with no rows at all', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    renderParts([think('a body', 1200), summary(), image({ width: 800, height: 600 }), error()]);

    expect(rowShells()).toEqual([]);
    expect(api.getDiagnostics().registeredRows).toBe(0);
    expect(document.body.textContent).toContain('a body');
  });
});

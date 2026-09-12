import React, { useRef } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import type { ContentRowWindowingRuntime } from '../contentRowTypes';
import Image from '../../Content/Image';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/**
 * Stage 3 task 3.5 — the image dialog as the first production call site of the portal pin.
 *
 * The real dialog is rendered (no DialogImage mock) inside a real image row, so this covers the
 * whole chain: opening the dialog pins the row, the portaled content element is registered with
 * the row, and closing releases both.
 */

const originalRAF = global.requestAnimationFrame;
const originalCAF = global.cancelAnimationFrame;
const originalIO = global.IntersectionObserver;
const originalRO = global.ResizeObserver;

let frameQueue: FrameRequestCallback[] = [];

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
  setContentRowWindowingEnabled(true, { isDevelopment: true });
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  global.IntersectionObserver = originalIO;
  global.ResizeObserver = originalRO;
  resetContentRowWindowingEnabledForTests();
  window.localStorage.clear();
  document.body.style.overflow = '';
});

let api: ContentRowWindowingRuntime;

function Probe() {
  api = useContentRowWindowing();
  return null;
}

function Harness({ children }: { children?: React.ReactNode }) {
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

const imageRow = (
  <VirtualizedContentRow messageId="m1" kind="image" sourceKey={0} ordinal={0}>
    <Image imagePath="/images/test.png" altText="Test image" width={800} height={600} />
  </VirtualizedContentRow>
);

const openDialog = () => document.querySelector('button[aria-haspopup="dialog"]') as HTMLElement;
const closeDialog = () =>
  document.querySelector('button[aria-label="com_ui_close"]') as HTMLElement;
const dialogContent = () => document.querySelector('div[role="dialog"]');

const portalPins = () => api.getDiagnostics().pinsByReason.portal;

describe('image dialog portal pin', () => {
  it('pins its row while the dialog is open and releases it on close', () => {
    render(<Harness>{imageRow}</Harness>);
    expect(portalPins()).toBe(0);

    act(() => {
      fireEvent.click(openDialog());
    });
    expect(portalPins()).toBe(1);

    act(() => {
      fireEvent.click(closeDialog());
    });
    expect(portalPins()).toBe(0);
  });

  it('registers the portaled content element, so focus inside it is inside the row', () => {
    // Real timers do not run the deferred focus release, so this test drives them explicitly:
    // without the registration the release fires and the focus pin drops.
    jest.useFakeTimers();
    render(<Harness>{imageRow}</Harness>);

    act(() => {
      fireEvent.click(openDialog());
    });
    const content = dialogContent();
    expect(content).not.toBeNull();

    act(() => {
      fireEvent.focus(closeDialog());
    });
    expect(api.getDiagnostics().pinsByReason.focus).toBe(1);

    // Focus moves from the row into the open dialog, which is outside the row's DOM subtree.
    act(() => {
      fireEvent.blur(document.querySelector('[data-content-virtual-row="true"]') as HTMLElement, {
        relatedTarget: content,
      });
      jest.runOnlyPendingTimers();
    });

    expect(api.getDiagnostics().pinsByReason.focus).toBe(1);
    expect(portalPins()).toBe(1);
    jest.useRealTimers();
  });

  it('releases the pin when the row unmounts with the dialog still open', () => {
    const { unmount } = render(<Harness>{imageRow}</Harness>);

    act(() => {
      fireEvent.click(openDialog());
    });
    expect(portalPins()).toBe(1);

    unmount();
    expect(portalPins()).toBe(0);
  });

  it('holds one pin across repeated open and close', () => {
    render(<Harness>{imageRow}</Harness>);

    for (const expected of [1, 0, 1, 0]) {
      act(() => {
        fireEvent.click(portalPins() === 0 ? openDialog() : closeDialog());
      });
      expect(portalPins()).toBe(expected);
    }
  });
});

describe('with the flag off', () => {
  it('renders the dialog with no row to pin', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    render(<Harness>{imageRow}</Harness>);

    expect(document.querySelector('[data-content-virtual-row]')).toBeNull();
    act(() => {
      fireEvent.click(openDialog());
    });
    expect(dialogContent()).not.toBeNull();
    expect(portalPins()).toBe(0);
  });
});

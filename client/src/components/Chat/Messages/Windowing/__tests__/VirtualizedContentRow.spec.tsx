import React, { useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import {
  resetContentRowWindowingEnabledForTests,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { createRowToken } from '../contentRowIdentity';
import {
  CONTENT_ROW_QUIET_FRAMES,
  NAVIGATION_MEASUREMENT_TIMEOUT_MS,
  type ContentRowWindowingRuntime,
} from '../contentRowTypes';

/* -------------------------------------------------------------------------- */
/* Frames and observers                                                       */
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
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;

function Probe() {
  api = useContentRowWindowing();
  return null;
}

function Harness({
  children,
  conversationId = 'conversation-1',
}: {
  children?: React.ReactNode;
  conversationId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="scroll-root">
      <ContentRowWindowingProvider scrollRootRef={scrollRef} conversationId={conversationId}>
        <Probe />
        {children}
      </ContentRowWindowingProvider>
    </div>
  );
}

const row = (
  overrides: Partial<React.ComponentProps<typeof VirtualizedContentRow>> & { key?: string } = {},
) => (
  <VirtualizedContentRow
    messageId="m1"
    kind="markdown"
    sourceKey={0}
    ordinal={0}
    {...overrides}
    key={overrides.key}
  >
    <div data-testid="content">{'row content'}</div>
  </VirtualizedContentRow>
);

/* -------------------------------------------------------------------------- */
/* Markup                                                                     */
/* -------------------------------------------------------------------------- */

describe('VirtualizedContentRow markup', () => {
  it('renders the documented virtual-row attributes', () => {
    render(<Harness>{row()}</Harness>);
    const shell = document.querySelector('[data-content-virtual-row="true"]');
    expect(shell).not.toBeNull();
    expect(shell?.getAttribute('data-content-row-kind')).toBe('markdown');
    expect(shell?.getAttribute('data-content-row-key')).toBe('m1:markdown:0');
    expect(shell?.getAttribute('data-content-mounted')).toBe('true');
    expect(shell?.getAttribute('data-content-generation')).toBe('1');
    expect(shell?.classList.contains('content-virtual-row')).toBe(true);
  });

  it('puts the measured content in a separate inner element', () => {
    render(<Harness>{row()}</Harness>);
    const shell = document.querySelector('[data-content-virtual-row="true"]');
    const measured = shell?.querySelector('.content-virtual-row__measured');
    expect(measured).not.toBeNull();
    expect(measured).toContainElement(screen.getByTestId('content'));
  });

  it('never puts message identity on a content row', () => {
    render(<Harness>{row({ messageId: 'm1' })}</Harness>);
    const shell = document.querySelector('[data-content-virtual-row="true"]') as HTMLElement;
    expect(shell.id).not.toBe('m1');
    expect(shell.classList.contains('message-render')).toBe(false);
    expect(shell.getAttribute('tabindex')).toBeNull();
    expect(shell.getAttribute('aria-label')).toBeNull();
  });

  it('registers one row and starts it mounted', () => {
    render(<Harness>{row()}</Harness>);
    const snapshot = api.getDiagnostics();
    expect(snapshot.registeredRows).toBe(1);
    expect(snapshot.mountedRows).toBe(1);
    expect(
      snapshot.mountStates.MOUNTED_UNMEASURED + snapshot.mountStates.MOUNTED_MEASURED_UNSETTLED,
    ).toBe(1);
  });

  it('renders a plain always-mounted block, with no registration, when the flag is off', () => {
    setContentRowWindowingEnabled(false, { isDevelopment: true });
    render(<Harness>{row()}</Harness>);
    expect(document.querySelector('[data-content-virtual-row]')).toBeNull();
    expect(screen.getByTestId('content')).toBeInTheDocument();
    expect(api.getDiagnostics().registeredRows).toBe(0);
  });

  it('renders a plain always-mounted block when there is no provider', () => {
    setContentRowWindowingEnabled(true, { isDevelopment: true });
    render(row());
    expect(document.querySelector('[data-content-virtual-row]')).toBeNull();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('keeps the row registered when only its fingerprint changes', () => {
    const { rerender } = render(<Harness>{row({ stateKey: 'collapsed' })}</Harness>);
    const before = api.getDiagnostics().registrations;
    rerender(<Harness>{row({ stateKey: 'expanded' })}</Harness>);
    const after = api.getDiagnostics();
    expect(after.registrations).toBe(before);
    expect(after.registeredRows).toBe(1);
    // the generation moved on because the source state changed
    expect(
      after.mountStates.MOUNTED_UNMEASURED + after.mountStates.MOUNTED_MEASURED_UNSETTLED,
    ).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Pins                                                                       */
/* -------------------------------------------------------------------------- */

describe('pins', () => {
  it('counts pins by reason while held and clears them on release', () => {
    const { rerender } = render(<Harness>{row({ pinReason: 'selection' })}</Harness>);
    expect(api.getDiagnostics().pinsByReason.selection).toBe(1);
    rerender(<Harness>{row()}</Harness>);
    expect(api.getDiagnostics().pinsByReason.selection).toBe(0);
  });

  it('keeps a pinned row mounted and registered', () => {
    render(<Harness>{row({ pinReason: 'focus' })}</Harness>);
    const shell = document.querySelector('[data-content-virtual-row="true"]') as HTMLElement;
    expect(shell.getAttribute('data-content-mounted')).toBe('true');
    const snapshot = api.getDiagnostics();
    expect(snapshot.pinsByReason.focus).toBe(1);
    expect(snapshot.mountedRows).toBe(1);
  });

  it('ignores a pin for an unknown token', () => {
    render(<Harness>{row()}</Harness>);
    const release = api.pinRow(createRowToken('nope'), 'debug');
    expect(typeof release).toBe('function');
    expect(() => release()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Materialization                                                            */
/* -------------------------------------------------------------------------- */

describe('materialization', () => {
  it('mounts every row and waits for the settle budget', async () => {
    render(<Harness>{[row({ ordinal: 1, key: 'a' }), row({ ordinal: 2, key: 'b' })]}</Harness>);
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
    let restore: (() => void) | undefined;
    await act(async () => {
      restore = await api.materializeAll('screenshot');
    });
    expect(api.getDiagnostics().mountedRows).toBe(2);
    expect(typeof restore).toBe('function');
    act(() => restore?.());
    expect(api.getDiagnostics().placeholderRows).toBe(0);
  });

  it('records a materialization timeout when settling never completes', async () => {
    jest.useFakeTimers();
    try {
      render(<Harness>{row()}</Harness>);
      // no frames are flushed: the readiness/quiet-frame barrier can never advance
      let restore: (() => void) | undefined;
      await act(async () => {
        const promise = api.materializeAll('screenshot');
        jest.advanceTimersByTime(1000);
        restore = await promise;
      });
      const snapshot = api.getDiagnostics();
      expect(snapshot.materializationTimeouts).toBe(1);
      expect(snapshot.materializationTimeoutDetails).toEqual(['screenshot']);
      // cleanup is still applied on timeout
      expect(typeof restore).toBe('function');
      act(() => restore?.());
    } finally {
      jest.useRealTimers();
    }
  });

  it('materializes synchronously for native find without waiting', () => {
    render(<Harness>{row()}</Harness>);
    act(() => api.materializeAllSync('find'));
    expect(api.getDiagnostics().mountedRows).toBe(1);
  });

  /**
   * §17.2 / §20.7.9. The previous version of this test asserted `reflowState === 'idle'`
   * immediately after materializing, without ever changing the conversation. `reflowState` was a
   * field that was written once at `'idle'` and never updated, so the assertion was a constant:
   * it passed with the defect present and would have passed with materialization never cleared at
   * all. The clear itself was also missing, so find mode survived every later conversation.
   */
  it('reports the materialization in the reflow state while it is held', () => {
    render(<Harness>{row()}</Harness>);
    expect(api.getDiagnostics().reflowState).toBe('idle');
    act(() => api.materializeAllSync('find'));
    expect(api.getDiagnostics().reflowState).toBe('reflow-materialized');
  });

  it('clears find materialization when the conversation changes', () => {
    const { rerender } = render(<Harness>{row()}</Harness>);
    act(() => api.materializeAllSync('find'));
    expect(api.getDiagnostics().reflowState).toBe('reflow-materialized');

    rerender(<Harness conversationId="conversation-2">{row()}</Harness>);

    expect(api.getDiagnostics().reflowState).toBe('idle');
    // Windowing must be usable again: a pass that arrives after the change is no longer
    // discarded because a materialization owns mount state.
    expect(api.getDiagnostics().discardedPasses.materializing).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Navigation                                                                 */
/* -------------------------------------------------------------------------- */

describe('ensureMessageContentMounted', () => {
  it('resolves the message shell once a current-generation measurement exists', async () => {
    render(
      <Harness>
        <div className="message-render" id="m1">
          {row()}
        </div>
      </Harness>,
    );
    const shell = await api.ensureMessageContentMounted('m1');
    expect(shell?.classList.contains('message-render')).toBe(true);
    expect(shell?.id).toBe('m1');
  });

  it('is bounded by the navigation timeout when no measurement arrives', async () => {
    render(<Harness>{row()}</Harness>);
    // no .message-render ancestor and no measurement wait releaser, so this must still settle
    const started = Date.now();
    const result = await api.ensureMessageContentMounted('m1');
    expect(Date.now() - started).toBeLessThan(NAVIGATION_MEASUREMENT_TIMEOUT_MS + 500);
    expect(result === null || result instanceof HTMLElement).toBe(true);
  });

  it('resolves null for a message with no rows', async () => {
    render(<Harness>{row()}</Harness>);
    await expect(api.ensureMessageContentMounted('unknown')).resolves.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Layout change notification                                                 */
/* -------------------------------------------------------------------------- */

describe('notifyLayoutChange', () => {
  it('invalidates the affected row and re-measures it', () => {
    render(<Harness>{row()}</Harness>);
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
    expect(api.getDiagnostics().measuredHeightDistribution.count).toBe(1);
    act(() => api.notifyLayoutChange({ messageId: 'm1' }));
    const snapshot = api.getDiagnostics();
    // the height is dropped immediately and the mounted element is re-measured, so the row is
    // never left holding a height that no longer describes the content
    expect(snapshot.measuredHeightDistribution.count).toBe(1);
    expect(snapshot.staleRows).toBe(0);
    expect(
      snapshot.mountStates.MOUNTED_MEASURED_SETTLED +
        snapshot.mountStates.MOUNTED_MEASURED_UNSETTLED,
    ).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Fixture                                                                    */
/* -------------------------------------------------------------------------- */

describe('dev fixture', () => {
  it('builds deterministic rows with the expected fixture cases', async () => {
    // imported dynamically: the fixture chunk is lazily loaded and never part of the
    // production graph
    const { buildRows } = await import('../dev/ContentRowFixture');
    const rows = buildRows(14, 0);
    expect(rows).toHaveLength(14);
    expect(rows.every((spec: { id: string }) => typeof spec.id === 'string')).toBe(true);
    expect(rows.some((spec: { neverSettles?: boolean }) => spec.neverSettles)).toBe(true);
    expect(rows.some((spec: { readyAfterMs?: number }) => spec.readyAfterMs != null)).toBe(true);
    expect(rows.some((spec: { growth?: number }) => spec.growth != null)).toBe(true);
    expect(buildRows(14, 0)).toEqual(rows);
  });
});

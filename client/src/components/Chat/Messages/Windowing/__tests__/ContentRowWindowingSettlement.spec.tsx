import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import {
  ContentRowWindowingProvider,
  canRowUnmount,
  useContentRowWindowing,
} from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import {
  CONTENT_ROW_QUIET_FRAMES,
  CONTENT_ROW_SETTLEMENT_TIMEOUT_MS,
  type ContentRowRecord,
  type ContentRowWindowingRuntime,
} from '../contentRowTypes';

/* -------------------------------------------------------------------------- */
/* Deterministic frames and clock                                             */
/* -------------------------------------------------------------------------- */

const originalRAF = global.requestAnimationFrame;
const originalCAF = global.cancelAnimationFrame;
let frameQueue: FrameRequestCallback[] = [];

function flushFrames(count = 1) {
  for (let index = 0; index < count; index++) {
    const queue = frameQueue;
    frameQueue = [];
    act(() => {
      queue.forEach((callback) => callback(performance.now()));
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
  global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frameQueue.push(callback);
    return frameQueue.length;
  }) as unknown as typeof requestAnimationFrame;
  global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  jest.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  global.requestAnimationFrame = originalRAF;
  global.cancelAnimationFrame = originalCAF;
  performance.now = originalNow;
});

/* -------------------------------------------------------------------------- */
/* Fonts                                                                      */
/* -------------------------------------------------------------------------- */

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res as () => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
let fontsDeferred: Deferred;

const installFonts = (deferredInstance: Deferred | null) => {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: deferredInstance == null ? undefined : { ready: deferredInstance.promise },
  });
};

beforeEach(() => {
  fontsDeferred = deferred();
  installFonts(fontsDeferred);
});

afterEach(() => {
  if (originalFonts) {
    Object.defineProperty(document, 'fonts', originalFonts);
  } else {
    delete (document as unknown as { fonts?: unknown }).fonts;
  }
});

const resolveFonts = () => {
  act(() => {
    fontsDeferred.resolve();
  });
  // let the promise continuation run
  return Promise.resolve();
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;
let registered: Array<{
  token: symbol;
  generation: number;
  setMounted: jest.Mock;
  element: HTMLElement;
}> = [];

function Row({
  messageId = 'm1',
  kind = 'markdown' as const,
  height = 200,
  readiness,
  mountContent = true,
}: {
  messageId?: string;
  kind?: 'markdown' | 'image' | 'generic';
  height?: number;
  readiness?: Promise<unknown>;
  mountContent?: boolean;
}) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const token = useRef(createRowToken(messageId));
  const scopeToken = useRef(createScopeToken());
  const setMounted = useRef(jest.fn()).current;
  const [generation, setGeneration] = React.useState(1);

  useLayoutEffect(() => {
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId,
      debugKey: `${messageId}:${kind}:0`,
      kind,
      fingerprint: composeFingerprint({ kind, sourceKey: 0 }),
      policy: 'windowed',
      forceMounted: false,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted: (mounted: boolean, nextGeneration: number) => {
        setMounted(mounted, nextGeneration);
        setGeneration(nextGeneration);
      },
    });
  }, [windowing, messageId, kind, setMounted]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) {
      return;
    }
    const bucket = windowing.getLayoutBucket();
    const unregister = windowing.registerMountedContent({
      token: token.current,
      generation,
      layoutBucket: bucket,
      element,
    });
    registered.push({ token: token.current, generation, setMounted, element });
    windowing.reportMountedContentHeight(
      token.current,
      generation,
      bucket,
      element,
      height,
      'layout-effect',
    );
    return unregister;
  }, [windowing, generation, height, setMounted]);

  useLayoutEffect(() => {
    if (!readiness) {
      return;
    }
    return windowing.registerReadiness(token.current, generation, readiness);
  }, [windowing, generation, readiness]);

  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef}>
        {mountContent ? <div key={generation} ref={contentRef} style={{ height }} /> : null}
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
    <div ref={scrollRootRef}>
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

beforeEach(() => {
  registered = [];
});

const unsettled = () => api.getDiagnostics().unsettledRows;
const settled = () => api.getDiagnostics().mountStates.MOUNTED_MEASURED_SETTLED;

/** Drive the row all the way to settled. */
async function settleWithFonts() {
  await resolveFonts();
  flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
}

/* -------------------------------------------------------------------------- */
/* Settlement                                                                 */
/* -------------------------------------------------------------------------- */

describe('settlement', () => {
  it('settles a measured row after the configured quiet frames', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    expect(settled()).toBe(0);
    await settleWithFonts();
    expect(settled()).toBe(1);
    expect(unsettled()).toBe(0);
  });

  it('does not settle while fonts are still loading', () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 5);
    expect(settled()).toBe(0);
    expect(api.getDiagnostics().warmUpComplete).toBe(false);
  });

  it('restarts the quiet-frame count when a resize arrives between frames', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    await resolveFonts();
    flushFrames(1);
    // a resize arrives: not quiet, so the count restarts
    act(() => {
      api.reportMountedContentHeight(
        registered[0].token,
        registered[0].generation,
        api.getLayoutBucket(),
        document.querySelector('[style]') as HTMLElement,
        210,
        'resize-observer',
      );
    });
    flushFrames(CONTENT_ROW_QUIET_FRAMES - 1);
    expect(settled()).toBe(0);
    flushFrames(2);
    expect(settled()).toBe(1);
  });

  it('ignores a stale generation when asked to settle', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    await resolveFonts();
    act(() => {
      api.markRowSettled(registered[0].token, registered[0].generation + 3);
    });
    expect(settled()).toBe(0);
  });

  it('refuses to settle a row that has no accepted measurement', async () => {
    // no content element is mounted, so nothing is ever measured
    render(
      <Harness>
        <Row messageId="m1" mountContent={false} />
      </Harness>,
    );
    await resolveFonts();
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 3);
    const snapshot = api.getDiagnostics();
    expect(snapshot.unmeasuredRows).toBe(1);
    expect(snapshot.mountStates.MOUNTED_MEASURED_SETTLED).toBe(0);
    expect(snapshot.alwaysMountedRows).toBe(0);
    void registered;
  });

  it('walks the documented mount state machine', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    // the layout-effect measurement lands during mount, so the row is already measured
    const afterMount = api.getDiagnostics();
    expect(afterMount.mountStates.MOUNTED_UNMEASURED).toBe(0);
    expect(afterMount.mountStates.MOUNTED_MEASURED_UNSETTLED).toBe(1);

    await settleWithFonts();
    expect(api.getDiagnostics().mountStates.MOUNTED_MEASURED_SETTLED).toBe(1);

    // A fingerprint change invalidates and restarts the generation. The row remounts its
    // measured element within the same commit, so it must come back as unmeasured-or-
    // unsettled and never as a settled row holding the previous source's height.
    act(() => {
      api.updateRow(registered[0].token, { fingerprint: 'markdown|0|v2' });
    });
    const afterChange = api.getDiagnostics();
    expect(afterChange.mountStates.MOUNTED_MEASURED_SETTLED).toBe(0);
    expect(
      afterChange.mountStates.MOUNTED_UNMEASURED +
        afterChange.mountStates.MOUNTED_MEASURED_UNSETTLED,
    ).toBe(1);
    expect(afterChange.staleRows).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Readiness barriers                                                         */
/* -------------------------------------------------------------------------- */

describe('asynchronous renderer readiness', () => {
  it('does not settle a row while an asynchronous renderer is pending', async () => {
    const readiness = deferred();
    render(
      <Harness>
        <Row messageId="m1" readiness={readiness.promise} />
      </Harness>,
    );
    await resolveFonts();
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 5);
    expect(settled()).toBe(0);
    expect(unsettled()).toBe(1);
  });

  it('settles once the renderer reports ready', async () => {
    const readiness = deferred();
    render(
      <Harness>
        <Row messageId="m1" readiness={readiness.promise} />
      </Harness>,
    );
    await resolveFonts();
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 2);
    expect(settled()).toBe(0);
    await act(async () => {
      readiness.resolve();
    });
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
    expect(settled()).toBe(1);
  });

  it('treats a rejected readiness promise as released', async () => {
    const readiness = deferred();
    render(
      <Harness>
        <Row messageId="m1" readiness={readiness.promise} />
      </Harness>,
    );
    await resolveFonts();
    await act(async () => {
      readiness.reject(new Error('decode failed'));
    });
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
    expect(settled()).toBe(1);
  });

  it('sends the row back to unsettled when new readiness is registered after settling', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    await settleWithFonts();
    expect(settled()).toBe(1);
    const late = deferred();
    act(() => {
      api.registerReadiness(registered[0].token, registered[0].generation, late.promise);
    });
    const snapshot = api.getDiagnostics();
    expect(snapshot.mountStates.MOUNTED_MEASURED_SETTLED).toBe(0);
    expect(snapshot.mountStates.MOUNTED_MEASURED_UNSETTLED).toBe(1);
  });

  it('ignores a readiness registration for a superseded generation', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    const never = new Promise<void>(() => {});
    act(() => {
      api.registerReadiness(registered[0].token, registered[0].generation + 1, never);
    });
    await settleWithFonts();
    expect(settled()).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Settlement timeout                                                         */
/* -------------------------------------------------------------------------- */

describe('settlement timeout', () => {
  it('demotes a row that never goes quiet to an effective always-mounted policy', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    await resolveFonts();
    // every frame brings a fresh resize, so the quiet-frame count never completes
    const { token, generation, element } = registered[0];
    for (let index = 0; index < 5; index++) {
      act(() => {
        api.reportMountedContentHeight(
          token,
          generation,
          api.getLayoutBucket(),
          element,
          200 + index,
          'resize-observer',
        );
      });
      flushFrames(1);
      advanceClock(CONTENT_ROW_SETTLEMENT_TIMEOUT_MS / 4);
    }
    expect(settled()).toBe(0);
    flushFrames(1);
    const snapshot = api.getDiagnostics();
    expect(snapshot.settlementTimeouts).toBe(1);
    expect(snapshot.alwaysMountedRows).toBe(1);
    expect(snapshot.settlementTimeoutDetails).toHaveLength(1);
    expect(snapshot.settlementTimeoutDetails[0].debugKey).toBe('m1:markdown:0');
    expect(snapshot.settlementTimeoutDetails[0].kind).toBe('markdown');
    // the row stays mounted and is still counted as unsettled, not as settled
    expect(snapshot.mountedRows).toBe(1);
    expect(snapshot.unsettledRows).toBe(1);
  });

  it('records a readiness timeout when the budget expires with a renderer still pending', async () => {
    const readiness = deferred();
    render(
      <Harness>
        <Row messageId="m1" readiness={readiness.promise} />
      </Harness>,
    );
    await resolveFonts();
    advanceClock(CONTENT_ROW_SETTLEMENT_TIMEOUT_MS + 1);
    flushFrames(1);
    const snapshot = api.getDiagnostics();
    expect(snapshot.settlementTimeouts).toBe(1);
    expect(snapshot.readinessTimeouts).toBe(1);
    expect(snapshot.readinessTimeoutDetails[0].debugKey).toBe('m1:markdown:0');
  });

  it('does not demote a row that settles inside its budget', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    await settleWithFonts();
    advanceClock(CONTENT_ROW_SETTLEMENT_TIMEOUT_MS * 2);
    flushFrames(2);
    const snapshot = api.getDiagnostics();
    expect(snapshot.settlementTimeouts).toBe(0);
    expect(snapshot.alwaysMountedRows).toBe(0);
    expect(snapshot.mountStates.MOUNTED_MEASURED_SETTLED).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Warm-up                                                                    */
/* -------------------------------------------------------------------------- */

describe('warm-up', () => {
  it('completes after fonts are ready and every row has settled', async () => {
    render(
      <Harness>
        <Row messageId="m1" />
        <Row messageId="m2" />
      </Harness>,
    );
    expect(api.getDiagnostics().warmUpComplete).toBe(false);
    await resolveFonts();
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
    const snapshot = api.getDiagnostics();
    expect(snapshot.warmUpComplete).toBe(true);
    expect(snapshot.warmUpDurationMs).not.toBeNull();
  });

  it('does not complete while a row is still unsettled', async () => {
    const readiness = deferred();
    render(
      <Harness>
        <Row messageId="m1" />
        <Row messageId="m2" readiness={readiness.promise} />
      </Harness>,
    );
    await resolveFonts();
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 2);
    expect(api.getDiagnostics().warmUpComplete).toBe(false);
  });

  it('completes even when a row was demoted by the settlement timeout', async () => {
    const readiness = deferred();
    render(
      <Harness>
        <Row messageId="m1" readiness={readiness.promise} />
      </Harness>,
    );
    await resolveFonts();
    advanceClock(CONTENT_ROW_SETTLEMENT_TIMEOUT_MS + 1);
    flushFrames(2);
    const snapshot = api.getDiagnostics();
    expect(snapshot.settlementTimeouts).toBe(1);
    expect(snapshot.warmUpComplete).toBe(true);
  });

  it('treats a missing Font Loading API as already ready', async () => {
    installFonts(null);
    render(
      <Harness>
        <Row messageId="m1" />
      </Harness>,
    );
    flushFrames(CONTENT_ROW_QUIET_FRAMES + 1);
    expect(settled()).toBe(1);
  });

  it('starts a fresh warm-up on a conversation change', async () => {
    const { rerender } = render(
      <Harness conversationId="conversation-1">
        <Row messageId="m1" />
      </Harness>,
    );
    await settleWithFonts();
    expect(api.getDiagnostics().warmUpComplete).toBe(true);
    rerender(
      <Harness conversationId="conversation-2">
        <Row messageId="m1" />
      </Harness>,
    );
    expect(api.getDiagnostics().warmUpComplete).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Unmount eligibility policy                                                 */
/* -------------------------------------------------------------------------- */

describe('canRowUnmount', () => {
  const record = (overrides: Partial<ContentRowRecord> = {}): ContentRowRecord =>
    ({
      token: Symbol('row'),
      scopeToken: Symbol('scope'),
      messageId: 'm1',
      conversationId: 'conversation-1',
      debugKey: 'm1:markdown:0',
      kind: 'markdown',
      fingerprint: 'markdown|0',
      measuredFingerprint: 'markdown|0',
      policy: 'windowed',
      shellElement: null,
      measuredElement: null,
      mounted: true,
      committedMounted: true,
      generation: 2,
      layoutBucket: 'w50-f32-markdown',
      measuredHeight: 180,
      mountState: 'MOUNTED_MEASURED_SETTLED',
      settled: true,
      forceMounted: false,
      oversized: false,
      pinnedByPolicy: null,
      pins: new Set(),
      readinessPending: 0,
      measurementWaiters: new Set(),
      setMounted: () => {},
      commitWaiters: new Set(),
      ...overrides,
    }) as ContentRowRecord;

  it('allows an ordinary settled, measured, windowed row', () => {
    expect(canRowUnmount(record())).toBe(true);
  });

  it.each([
    ['unmeasured', { measuredHeight: undefined }],
    ['unsettled', { settled: false, mountState: 'MOUNTED_MEASURED_UNSETTLED' as const }],
    ['stale measurement', { measuredFingerprint: 'markdown|0|old' }],
    ['placeholder already', { mountState: 'PLACEHOLDER_MEASURED' as const }],
    ['not mounted', { mounted: false }],
    ['always-mounted policy', { policy: 'always-mounted' as const }],
    ['unstable-until-settled policy', { policy: 'unstable-until-settled' as const }],
    ['pinned by policy', { pinnedByPolicy: 'settlement-timeout' as const }],
    ['oversized', { oversized: true }],
    ['force mounted', { forceMounted: true }],
    ['pinned', { pins: new Set(['focus'] as const) }],
    ['pending reader', { readinessPending: 1 }],
  ])('refuses to unmount a row that is %s', (_label, overrides) => {
    expect(canRowUnmount(record(overrides as Partial<ContentRowRecord>))).toBe(false);
  });
});

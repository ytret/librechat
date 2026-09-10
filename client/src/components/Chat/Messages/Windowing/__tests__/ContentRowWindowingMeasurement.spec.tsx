import React, { useLayoutEffect, useRef } from 'react';
import { act, render } from '@testing-library/react';
import {
  ContentRowWindowingProvider,
  readElementBorderBoxHeight,
  useContentRowWindowing,
} from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import type { ContentRowRejectReason, ContentRowWindowingRuntime } from '../contentRowTypes';

/* -------------------------------------------------------------------------- */
/* Observer doubles                                                          */
/* -------------------------------------------------------------------------- */

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observed: Element[] = [];
  unobserve = jest.fn((target: Element) => {
    this.observed = this.observed.filter((element) => element !== target);
  });

  disconnect = jest.fn(() => {
    this.observed = [];
  });

  observe = jest.fn((target: Element) => {
    this.observed.push(target);
  });

  constructor(public callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }

  resize(target: Element, blockSize: number | undefined, contentHeight = 0) {
    const entry = {
      target,
      borderBoxSize: blockSize == null ? undefined : [{ blockSize }],
      contentRect: { height: contentHeight },
    } as unknown as ResizeObserverEntry;
    act(() => {
      this.callback([entry], this as unknown as ResizeObserver);
    });
  }
}

const originalRO = global.ResizeObserver;

beforeEach(() => {
  MockResizeObserver.instances = [];
  global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  global.ResizeObserver = originalRO;
});

const resizeObserver = () => {
  const observer = MockResizeObserver.instances[0];
  if (!observer) {
    throw new Error('no resize observer was created');
  }
  return observer;
};

/* -------------------------------------------------------------------------- */
/* Harness                                                                   */
/* -------------------------------------------------------------------------- */

let api: ContentRowWindowingRuntime;
let rows: Array<{ token: symbol; generation: number; setMounted: jest.Mock; observe: () => void }> =
  [];

/**
 * Mirrors what `VirtualizedContentRow` does in Stage 2 task 2.7: the persistent shell
 * is registered with the provider, and the generation-specific inner element is
 * registered as the measured content from a layout effect, then measured once.
 */
function MeasuredRow({
  messageId = 'm1',
  kind = 'markdown' as const,
  mountContent = true,
  reportLayoutEffect = true,
  onElement,
}: {
  messageId?: string;
  kind?: 'markdown' | 'image' | 'generic';
  mountContent?: boolean;
  reportLayoutEffect?: boolean;
  onElement?: (element: HTMLElement | null) => void;
}) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const token = useRef(createRowToken(messageId));
  const scopeToken = useRef(createScopeToken());
  const setMounted = useRef(jest.fn()).current;
  const [generation, setGeneration] = React.useState(1);

  // A layout effect, so the registry record exists before the content layout effect
  // below registers the measured element for this generation.
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
    onElement?.(element);
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
    rows.push({
      token: token.current,
      generation,
      setMounted,
      observe: () =>
        resizeObserver().resize(element, undefined, readElementBorderBoxHeight(element)),
    });
    if (reportLayoutEffect) {
      windowing.reportMountedContentHeight(
        token.current,
        generation,
        bucket,
        element,
        readElementBorderBoxHeight(element),
        'layout-effect',
      );
    }
    return unregister;
  }, [windowing, generation, reportLayoutEffect, onElement, setMounted]);

  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef} data-testid={`shell-${messageId}`}>
        {mountContent ? (
          <div
            key={generation}
            ref={contentRef}
            data-content-generation={generation}
            data-testid={`content-${messageId}`}
          />
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
    <div ref={scrollRootRef}>
      <ContentRowWindowingProvider scrollRootRef={scrollRootRef} conversationId={conversationId}>
        <Probe />
        {children}
      </ContentRowWindowingProvider>
    </div>
  );
}

function Probe() {
  const windowing = useContentRowWindowing();
  api = windowing;
  return null;
}

/** A row that registers its own shell only, used to check observer targets. */
beforeEach(() => {
  rows = [];
});

function heightOf(): number {
  return api.getDiagnostics().measuredHeightDistribution.count;
}

function rejected(reason: ContentRowRejectReason): number {
  return api.getDiagnostics().rejectedByReason[reason];
}

/* -------------------------------------------------------------------------- */
/* Shared observer                                                           */
/* -------------------------------------------------------------------------- */

describe('shared resize observer', () => {
  it('creates exactly one observer for many rows', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" />
        <MeasuredRow messageId="m2" />
        <MeasuredRow messageId="m3" />
      </Harness>,
    );
    expect(MockResizeObserver.instances).toHaveLength(1);
  });

  it('observes the measured content element, never the persistent shell', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" />
      </Harness>,
    );
    const observer = resizeObserver();
    const content = document.querySelector('[data-testid="content-m1"]');
    const shell = document.querySelector('[data-testid="shell-m1"]');
    expect(content).not.toBeNull();
    expect(shell).not.toBeNull();
    expect(observer.observed).toContain(content);
    expect(observer.observed).not.toContain(shell);
  });

  it('stops observing an element when the row unmounts', () => {
    const { rerender } = render(
      <Harness>
        <MeasuredRow messageId="m1" key="a" />
      </Harness>,
    );
    const observer = resizeObserver();
    const content = document.querySelector('[data-testid="content-m1"]');
    expect(observer.observed).toContain(content);
    rerender(<Harness>{null}</Harness>);
    expect(observer.observed).not.toContain(content);
  });

  it('observes a row that mounts after the observer already exists', () => {
    const { rerender } = render(<Harness>{null}</Harness>);
    const observer = resizeObserver();
    expect(observer.observed).toHaveLength(0);
    rerender(
      <Harness>
        <MeasuredRow messageId="late" />
      </Harness>,
    );
    const content = document.querySelector('[data-testid="content-late"]');
    expect(observer.observed).toContain(content);
  });

  it('disconnects on provider unmount', () => {
    const { unmount } = render(
      <Harness>
        <MeasuredRow messageId="m1" />
      </Harness>,
    );
    const observer = resizeObserver();
    unmount();
    expect(observer.disconnect).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Measurement acceptance                                                     */
/* -------------------------------------------------------------------------- */

describe('measurement acceptance', () => {
  it('accepts the layout-effect measurement of the current generation', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" />
      </Harness>,
    );
    const snapshot = api.getDiagnostics();
    expect(snapshot.acceptedMeasurementsBySource['layout-effect']).toBe(1);
    expect(snapshot.acceptedMeasurements).toBe(1);
    expect(snapshot.unmeasuredRows).toBe(0);
    expect(snapshot.mountStates.MOUNTED_MEASURED_UNSETTLED).toBe(1);
    expect(snapshot.rejectedMeasurements).toBe(0);
  });

  it('accepts a resize-observer measurement and prefers the border-box size', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, 321.5, 999);
    const snapshot = api.getDiagnostics();
    expect(snapshot.acceptedMeasurementsBySource['resize-observer']).toBe(1);
    // borderBoxSize wins over the content rect
    expect(snapshot.measuredHeightDistribution.max).toBe(321.5);
  });

  it('falls back to the content rect height when there is no border-box size', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, undefined, 222);
    expect(api.getDiagnostics().measuredHeightDistribution.max).toBe(222);
  });

  it('retains the exact browser value rather than a rounded one', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, 100.4, 0);
    expect(api.getDiagnostics().measuredHeightDistribution.total).toBe(100.4);
  });

  it('accepts a zero height, which is a real measurement', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, 0, 0);
    const snapshot = api.getDiagnostics();
    expect(snapshot.unmeasuredRows).toBe(0);
    expect(snapshot.measuredHeightDistribution.count).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Measurement rejection                                                      */
/* -------------------------------------------------------------------------- */

describe('measurement rejection', () => {
  it('rejects an observer entry for an element no longer registered', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" />
      </Harness>,
    );
    resizeObserver().resize(document.createElement('div'), 100);
    expect(rejected('unknown-element')).toBe(1);
    expect(api.getDiagnostics().staleMeasurementsAccepted).toBe(0);
  });

  it('rejects a queued observer entry from a superseded generation', () => {
    const { rerender } = render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const staleElement = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    const staleToken = rows[0].token;

    // a fingerprint change restarts the generation and re-keys the measured element
    act(() => {
      api.updateRow(staleToken, { fingerprint: 'markdown|0|v2' });
    });
    rerender(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );

    // the queued callback for the old element must not be accepted
    resizeObserver().resize(staleElement, 500);
    const snapshot = api.getDiagnostics();
    expect(snapshot.measuredHeightDistribution.count).toBe(0);
    expect(
      snapshot.rejectedByReason['unknown-element'] + snapshot.rejectedByReason['element-mismatch'],
    ).toBeGreaterThan(0);
    expect(snapshot.staleMeasurementsAccepted).toBe(0);
  });

  it('rejects a measurement reported for another layout bucket', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    act(() => {
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation,
        'w99-f99-plain',
        element,
        400,
        'resize-observer',
      );
    });
    expect(rejected('bucket-mismatch')).toBe(1);
    expect(heightOf()).toBe(0);
  });

  it('rejects a measurement reported for another generation', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    act(() => {
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation + 5,
        api.getLayoutBucket(),
        element,
        400,
        'resize-observer',
      );
    });
    expect(rejected('generation-mismatch')).toBe(1);
    expect(heightOf()).toBe(0);
  });

  it('rejects a measurement for an unknown token', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    act(() => {
      api.reportMountedContentHeight(
        createRowToken('orphan'),
        1,
        api.getLayoutBucket(),
        document.createElement('div'),
        100,
        'resize-observer',
      );
    });
    expect(rejected('no-record')).toBe(1);
    expect(api.getDiagnostics().staleMeasurementsAccepted).toBe(0);
  });

  it('rejects a measurement from a different element of the same generation', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    act(() => {
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation,
        api.getLayoutBucket(),
        document.createElement('div'),
        100,
        'resize-observer',
      );
    });
    expect(rejected('element-mismatch')).toBe(1);
    expect(heightOf()).toBe(0);
  });

  it('rejects a negative or non-finite height', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    act(() => {
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation,
        api.getLayoutBucket(),
        element,
        Number.NaN,
        'resize-observer',
      );
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation,
        api.getLayoutBucket(),
        element,
        -1,
        'resize-observer',
      );
    });
    expect(rejected('invalid-height')).toBe(2);
    expect(heightOf()).toBe(0);
  });

  it('never accepts a stale or placeholder measurement across the whole rejection matrix', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    act(() => {
      api.reportMountedContentHeight(
        createRowToken('x'),
        1,
        'w0-f32-markdown',
        element,
        10,
        'resize-observer',
      );
      api.reportMountedContentHeight(
        rows[0].token,
        99,
        'w0-f32-markdown',
        element,
        10,
        'resize-observer',
      );
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation,
        'w0-f32-markdown',
        element,
        Number.NaN,
        'resize-observer',
      );
    });
    const snapshot = api.getDiagnostics();
    expect(snapshot.staleMeasurementsAccepted).toBe(0);
    // the one accepted measurement from the layout effect is still the only one
    expect(snapshot.acceptedMeasurements).toBe(1);
  });

  it('keeps the accepted height when a later measurement is rejected', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, 240, 0);
    expect(api.getDiagnostics().measuredHeightDistribution.max).toBe(240);
    act(() => {
      api.reportMountedContentHeight(
        rows[0].token,
        99,
        'w0-f32-markdown',
        element,
        999,
        'resize-observer',
      );
    });
    expect(api.getDiagnostics().measuredHeightDistribution.max).toBe(240);
  });
});

/* -------------------------------------------------------------------------- */
/* Element and bucket changes                                                 */
/* -------------------------------------------------------------------------- */

describe('measured element lifecycle', () => {
  it('clears the measurement when the measured element is replaced', () => {
    const { rerender } = render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, 300, 0);
    expect(heightOf()).toBe(1);

    act(() => {
      api.updateRow(rows[0].token, { fingerprint: 'markdown|0|v2' });
    });
    rerender(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const snapshot = api.getDiagnostics();
    expect(snapshot.measuredHeightDistribution.count).toBe(0);
    expect(snapshot.mountStates.MOUNTED_UNMEASURED).toBe(1);
  });

  it('treats a bucket change reported with the element as an invalidation', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const element = document.querySelector('[data-testid="content-m1"]') as HTMLElement;
    resizeObserver().resize(element, 300, 0);
    expect(heightOf()).toBe(1);

    // simulate the row re-registering its content under a new bucket
    act(() => {
      api.registerMountedContent({
        token: rows[0].token,
        generation: rows[0].generation,
        layoutBucket: 'w99-f32-markdown',
        element,
      });
      api.reportMountedContentHeight(
        rows[0].token,
        rows[0].generation,
        'w99-f32-markdown',
        element,
        310,
        'layout-effect',
      );
    });
    const snapshot = api.getDiagnostics();
    // the old height is gone, and the new-bucket measurement is accepted
    expect(snapshot.measuredHeightDistribution.count).toBe(1);
    expect(snapshot.measuredHeightDistribution.max).toBe(310);
    expect(snapshot.rejectedMeasurements).toBe(0);
  });

  it('ignores a content registration from a superseded generation', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" reportLayoutEffect={false} />
      </Harness>,
    );
    const before = api.getDiagnostics();
    const unregister = api.registerMountedContent({
      token: rows[0].token,
      generation: rows[0].generation + 1,
      layoutBucket: api.getLayoutBucket(),
      element: document.createElement('div'),
    });
    expect(typeof unregister).toBe('function');
    expect(() => unregister()).not.toThrow();
    expect(before.registeredRows).toBe(api.getDiagnostics().registeredRows);
  });

  it('reports the layout bucket through getLayoutBucket for content registration', () => {
    render(
      <Harness>
        <MeasuredRow messageId="m1" />
      </Harness>,
    );
    expect(api.getLayoutBucket()).toBe(api.getDiagnostics().layoutBucket);
  });
});

describe('readElementBorderBoxHeight', () => {
  it('reads the border-box height of an element', () => {
    const element = document.createElement('div');
    jest.spyOn(element, 'getBoundingClientRect').mockReturnValue({ height: 42.5 } as DOMRect);
    expect(readElementBorderBoxHeight(element)).toBe(42.5);
  });
});

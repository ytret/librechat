import {
  FRAME_VISIBILITY_HOLE_RUN,
  FRAME_VISIBILITY_PROBE_POINTS,
  classifyFrameVisibilityPoint,
  createFrameVisibilitySampler,
  formatFrameVisibilitySummary,
  readFrameVisibility,
  summarizeFrameVisibility,
  type FrameVisibilityHit,
  type FrameVisibilityPhase,
  type FrameVisibilitySample,
} from '../dev/frameVisibilitySampler';

/**
 * The §12.8 instrument is itself a measurement, and this session twice lost a round to a
 * measurement that lied (report §12.6, §12.8), plus once to this instrument's first version.
 * These tests pin the three things that version got wrong: what a probe point means, which
 * phase is trustworthy, and what counts as a hole rather than an inter-row margin.
 */

const reading = (
  frame: number,
  phase: FrameVisibilityPhase,
  overrides: Partial<FrameVisibilitySample> = {},
): FrameVisibilitySample => ({
  frame,
  phase,
  t: frame * 16,
  scrollTop: 0,
  scrollHeight: 10000,
  contentPoints: FRAME_VISIBILITY_PROBE_POINTS,
  placeholderPoints: 0,
  backgroundPoints: 0,
  bandPoints: FRAME_VISIBILITY_PROBE_POINTS,
  coverage: 1,
  longestBackgroundRun: 0,
  center: 'mounted',
  mountedRows: 8,
  placeholderRows: 72,
  scrollDelta: 0,
  scrollEvents: 0,
  ...overrides,
});

const blank = (frame: number, phase: FrameVisibilityPhase, overrides = {}) =>
  reading(frame, phase, {
    contentPoints: 0,
    placeholderPoints: 9,
    coverage: 0,
    center: 'placeholder',
    ...overrides,
  });

/* -------------------------------------------------------------------------- */
/* Point classification                                                       */
/* -------------------------------------------------------------------------- */

describe('classifyFrameVisibilityPoint', () => {
  const original = document.elementFromPoint;

  afterEach(() => {
    document.elementFromPoint = original;
  });

  const stub = (element: unknown) => {
    document.elementFromPoint = (() => element) as unknown as typeof document.elementFromPoint;
  };

  const insideRow = (mounted: boolean) => {
    const element = document.createElement('div');
    const ancestor = document.createElement('div');
    ancestor.setAttribute('data-content-virtual-row', 'true');
    ancestor.setAttribute('data-content-mounted', mounted ? 'true' : 'false');
    ancestor.appendChild(element);
    return element;
  };

  it('reports a mounted row as real content', () => {
    stub(insideRow(true));
    expect(classifyFrameVisibilityPoint(10, 10)).toBe('mounted');
  });

  it('reports a placeholder as blank, because it renders no content', () => {
    stub(insideRow(false));
    expect(classifyFrameVisibilityPoint(10, 10)).toBe('placeholder');
  });

  /**
   * Regression for the first version's false positive: an element outside any row is the
   * pane's own furniture. It used to be reported as a defect (`gap`), which made the
   * jump-buttons run report 1193 of 1193 frames as defective while the reader saw no blank.
   */
  it('reports an element outside any row as background, not as a defect', () => {
    stub(document.createElement('div'));
    expect(classifyFrameVisibilityPoint(10, 10)).toBe('background');
  });

  it('reports nothing under the point as background', () => {
    stub(null);
    expect(classifyFrameVisibilityPoint(10, 10)).toBe('background');
  });
});

/* -------------------------------------------------------------------------- */
/* One reading: band-relative coverage                                        */
/* -------------------------------------------------------------------------- */

describe('readFrameVisibility', () => {
  const original = document.elementFromPoint;

  afterEach(() => {
    document.elementFromPoint = original;
  });

  const PANE = { top: 0, bottom: 600, left: 0, width: 800 };

  const pane = (rows: number) => {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => PANE as DOMRect;
    Object.defineProperty(element, 'scrollTop', { value: 100, configurable: true });
    Object.defineProperty(element, 'scrollHeight', { value: 9000, configurable: true });
    const shells = new Array(rows).fill(null).map((_, index) => {
      const shell = document.createElement('div');
      shell.setAttribute('data-content-virtual-row', 'true');
      shell.setAttribute('data-content-mounted', index % 2 === 0 ? 'true' : 'false');
      // The real shells have layout. `readRowBand` derives the band from the first shell's top
      // and the last one's bottom, so those two readings have to be non-degenerate.
      shell.getBoundingClientRect = (() => {
        const first = index === 0;
        const last = index === rows - 1;
        return {
          top: first ? PANE.top : 100,
          bottom: last ? PANE.bottom : 500,
          left: 0,
          width: 800,
        } as DOMRect;
      }) as typeof shell.getBoundingClientRect;
      return shell;
    });
    element.querySelectorAll = ((selector: string) => {
      if (!selector.includes('data-content-virtual-row')) {
        return [];
      }
      // The band query selects on the row marker alone; only the count queries mention the
      // mounted flag. Conflating the two is what the first version of this fake did.
      if (!selector.includes('data-content-mounted')) {
        return shells;
      }
      const wanted = selector.includes('"false"') ? 'false' : 'true';
      return shells.filter((shell) => shell.getAttribute('data-content-mounted') === wanted);
    }) as unknown as typeof element.querySelectorAll;
    return element;
  };

  const stubHit = (hit: FrameVisibilityHit) => {
    if (hit === 'background') {
      document.elementFromPoint = (() => document.createElement('div')) as never;
      return;
    }
    document.elementFromPoint = (() => {
      const element = document.createElement('div');
      const ancestor = document.createElement('div');
      ancestor.setAttribute('data-content-virtual-row', 'true');
      ancestor.setAttribute('data-content-mounted', hit === 'mounted' ? 'true' : 'false');
      ancestor.appendChild(element);
      return element;
    }) as unknown as typeof document.elementFromPoint;
  };

  it('measures coverage over the row band only, ignoring furniture', () => {
    stubHit('mounted');
    const result = readFrameVisibility(pane(10), 0, 600);
    expect(result.contentPoints).toBe(FRAME_VISIBILITY_PROBE_POINTS);
    expect(result.backgroundPoints).toBe(0);
    expect(result.bandPoints).toBe(FRAME_VISIBILITY_PROBE_POINTS);
    expect(result.coverage).toBe(1);
    expect(result.center).toBe('mounted');
    expect(result.scrollTop).toBe(100);
  });

  it('counts a placeholder strip as zero coverage rather than as an error', () => {
    stubHit('placeholder');
    const result = readFrameVisibility(pane(10), 0, 600);
    expect(result.contentPoints).toBe(0);
    expect(result.placeholderPoints).toBe(FRAME_VISIBILITY_PROBE_POINTS);
    expect(result.coverage).toBe(0);
    expect(result.center).toBe('placeholder');
  });

  it('reports the row-shell counts the reader can see', () => {
    stubHit('mounted');
    const result = readFrameVisibility(pane(10), 0, 600);
    expect(result.mountedRows).toBe(5);
    expect(result.placeholderRows).toBe(5);
  });

  /**
   * Regression for the first version's second false positive. The fixture's "end of fixture"
   * filler sits below the last row; with no row band it was probed as a defect in every frame.
   * Points outside the band must be background and must not dilute coverage.
   */
  it('treats points outside the row band as background, whatever is under them', () => {
    stubHit('placeholder');
    const result = readFrameVisibility(pane(10), 0, 600, { top: 0, bottom: 200 });
    // Probe points every 66px: the band ends at 200px, so only the first ~3 are inside it.
    expect(result.placeholderPoints).toBeLessThan(FRAME_VISIBILITY_PROBE_POINTS);
    expect(result.backgroundPoints).toBeGreaterThan(0);
    expect(result.bandPoints).toBe(result.placeholderPoints);
    expect(result.coverage).toBe(0);
  });

  it('is vacuously covered when there are no rows at all, as with the flag off', () => {
    stubHit('mounted');
    const result = readFrameVisibility(pane(0), 0, 600);
    expect(result.bandPoints).toBe(0);
    expect(result.coverage).toBe(1);
  });

  it('flags a long background run as a hole, but not a single-point margin', () => {
    const hits: FrameVisibilityHit[] = ['mounted', 'background', 'mounted', 'mounted'];
    let call = 0;
    document.elementFromPoint = (() => {
      const hit = hits[Math.min(call, hits.length - 1)];
      call += 1;
      if (hit === 'background') {
        return document.createElement('div');
      }
      const element = document.createElement('div');
      const ancestor = document.createElement('div');
      ancestor.setAttribute('data-content-virtual-row', 'true');
      ancestor.setAttribute('data-content-mounted', 'true');
      ancestor.appendChild(element);
      return element;
    }) as unknown as typeof document.elementFromPoint;

    const margin = readFrameVisibility(pane(10), 0, 400, { top: 0, bottom: 600 });
    expect(margin.longestBackgroundRun).toBe(1);

    hits.splice(0, hits.length, 'background', 'background', 'background', 'mounted');
    call = 0;
    const hole = readFrameVisibility(pane(10), 0, 400, { top: 0, bottom: 600 });
    expect(hole.longestBackgroundRun).toBe(FRAME_VISIBILITY_HOLE_RUN);
  });
});

/* -------------------------------------------------------------------------- */
/* Summary: which phase is the verdict                                        */
/* -------------------------------------------------------------------------- */

describe('summarizeFrameVisibility', () => {
  it('separates a frame that painted blank from one repaired before the paint', () => {
    // Frame 0: the `raf` reading is empty but the pass ran after it — the `late` (post-pass,
    // pre-paint) reading has content, so nothing blank reached the screen.
    // Frame 1: the `late` reading is empty too — this frame painted blank.
    const summary = summarizeFrameVisibility([
      reading(0, 'raf', { contentPoints: 0, placeholderPoints: 9, coverage: 0 }),
      reading(0, 'late'),
      reading(0, 'post'),
      blank(1, 'raf'),
      blank(1, 'late'),
      reading(1, 'post'),
    ]);

    const raf = summary.channels.find((entry) => entry.phase === 'raf');
    const late = summary.channels.find((entry) => entry.phase === 'late');
    const post = summary.channels.find((entry) => entry.phase === 'post');
    expect(raf?.zeroContentFrames).toBe(2);
    expect(late?.zeroContentFrames).toBe(1);
    expect(post?.zeroContentFrames).toBe(0);
    expect(late?.frames).toBe(2);
    expect(late?.coverageMin).toBe(0);
    expect(late?.coverageMean).toBe(0.5);
  });

  it('reports a clean run as no blank frames and nothing to investigate', () => {
    const summary = summarizeFrameVisibility([
      reading(0, 'raf'),
      reading(0, 'late'),
      reading(0, 'post'),
    ]);
    expect(summary.channels.map((entry) => entry.zeroContentFrames)).toEqual([0, 0, 0]);
    expect(summary.channels.map((entry) => entry.coverageMin)).toEqual([1, 1, 1]);
    expect(summary.worstLate).toHaveLength(0);
    expect(formatFrameVisibilitySummary(summary).join('\n')).toContain(
      'every scroll frame painted real content',
    );
  });

  it('counts only frames that arrived at a new offset', () => {
    const summary = summarizeFrameVisibility([
      reading(0, 'raf', { scrollTop: 0 }),
      reading(1, 'raf', { scrollTop: 0 }),
      blank(2, 'raf', { scrollTop: 500 }),
      blank(2, 'late', { scrollTop: 500 }),
      blank(3, 'raf', { scrollTop: 500 }),
      blank(3, 'late', { scrollTop: 500 }),
      reading(4, 'raf', { scrollTop: 500 }),
    ]);
    expect(summary.offsetArrivals).toBe(1);
    expect(summary.arrivalsEmpty.raf).toBe(1);
    expect(summary.arrivalsEmpty.late).toBe(1);
    // Frame 2 is the arrival and frame 3 continues at the same offset before frame 4 is full.
    expect(summary.maxCatchUpFrames).toBe(2);
  });

  it('does not count a frame with no row shells as empty', () => {
    const summary = summarizeFrameVisibility([
      reading(0, 'raf', { bandPoints: 0, contentPoints: 0, placeholderPoints: 0 }),
    ]);
    expect(summary.channels[0].zeroContentFrames).toBe(0);
  });

  it('ranks the worst late frames by blankness, and only late frames', () => {
    const summary = summarizeFrameVisibility([
      blank(0, 'raf', { scrollDelta: 9000 }),
      blank(1, 'raf'),
      blank(1, 'late', { scrollDelta: -5400, mountedRows: 8, placeholderRows: 72 }),
      reading(2, 'late', { contentPoints: 6, placeholderPoints: 3, coverage: 6 / 9 }),
    ]);

    const lines = formatFrameVisibilitySummary(summary).join('\n');
    expect(summary.worstLate).toHaveLength(2);
    expect(summary.worstLate[0].frame).toBe(1);
    expect(lines).toContain('scrollTop=0 (delta -5400)');
    expect(lines).toContain('real 0 place 9 bg 0');
    expect(lines).toContain('real 6 place 3 bg 0');
  });
});

/* -------------------------------------------------------------------------- */
/* The sampler loop                                                           */
/* -------------------------------------------------------------------------- */

describe('createFrameVisibilitySampler', () => {
  const originalRAF = global.requestAnimationFrame;
  const originalCAF = global.cancelAnimationFrame;

  let frameQueue: FrameRequestCallback[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    frameQueue = [];
    global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      frameQueue.push(callback);
      return frameQueue.length;
    }) as unknown as typeof requestAnimationFrame;
    global.cancelAnimationFrame = (() => {}) as unknown as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    global.requestAnimationFrame = originalRAF;
    global.cancelAnimationFrame = originalCAF;
    jest.useRealTimers();
  });

  const fakePane = () => {
    const removes: string[] = [];
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, width: 800 }) as DOMRect;
    Object.defineProperty(element, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(element, 'scrollHeight', { value: 9000, configurable: true });
    element.querySelectorAll = (() => []) as unknown as typeof element.querySelectorAll;
    const addEventListener = element.addEventListener.bind(element);
    element.addEventListener = ((type: string, ...rest: unknown[]) => {
      addEventListener(type, ...(rest as [EventListenerOrEventListenerObject]));
    }) as typeof element.addEventListener;
    const removeEventListener = element.removeEventListener.bind(element);
    element.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removes.push(type);
      return (removeEventListener as unknown as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof element.removeEventListener;
    return { element, removes };
  };

  const runFrame = () => {
    const queue = frameQueue;
    frameQueue = [];
    queue.forEach((callback) => callback(0));
    jest.advanceTimersByTime(0);
  };

  it('refuses to sample without a scroll pane', () => {
    const sampler = createFrameVisibilitySampler();
    expect(sampler.start(null)).toContain('no scroll pane');
  });

  it('samples the frame and the post phase, and detaches on stop', () => {
    const { element, removes } = fakePane();
    const sampler = createFrameVisibilitySampler();
    expect(sampler.start(element, 30)).toContain('sampling for 30s');
    expect(sampler.start(element, 30)).toContain('already sampling');

    runFrame();
    const readings = sampler.readings();
    expect(readings.map((entry) => entry.phase)).toEqual(['raf', 'post']);
    expect(readings[0].frame).toBe(readings[1].frame);

    sampler.stop(false);
    expect(removes).toContain('scroll');
  });

  /**
   * The `late` channel is the whole point: it is registered from the sampler's scroll listener,
   * which is added after the provider's, so its callback is queued behind the pass that handler
   * registered and runs after it. Here the order of the queue proves the registration order.
   */
  it('samples a late reading from the scroll listener, after an earlier-registered pass', () => {
    const { element } = fakePane();
    const sampler = createFrameVisibilitySampler();
    let providerPasses = 0;
    // Stand in for the provider: registered first, so it runs first in the frame.
    element.addEventListener('scroll', () => {
      requestAnimationFrame(() => {
        providerPasses += 1;
      });
    });

    sampler.start(element, 30);
    runFrame();
    const firstFrameIndex = sampler.readings()[0].frame;

    element.dispatchEvent(new Event('scroll'));
    // Drain: the provider's callback first, then the sampler's `late` callback.
    for (let index = 0; index < 3; index += 1) {
      runFrame();
    }

    const late = sampler.readings().filter((entry) => entry.phase === 'late');
    expect(providerPasses).toBeGreaterThan(0);
    expect(late).toHaveLength(1);
    expect(late[0].frame).toBe(firstFrameIndex + 1);
    sampler.stop(false);
  });

  it('coalesces several scroll events in one frame into a single late reading', () => {
    const { element } = fakePane();
    const sampler = createFrameVisibilitySampler();
    sampler.start(element, 30);
    runFrame();
    element.dispatchEvent(new Event('scroll'));
    element.dispatchEvent(new Event('scroll'));
    element.dispatchEvent(new Event('scroll'));
    for (let index = 0; index < 3; index += 1) {
      runFrame();
    }
    expect(sampler.readings().filter((entry) => entry.phase === 'late')).toHaveLength(1);
    sampler.stop(false);
  });

  it('stops a queued late callback from sampling after stop', () => {
    const { element } = fakePane();
    const sampler = createFrameVisibilitySampler();
    sampler.start(element, 30);
    runFrame();
    element.dispatchEvent(new Event('scroll'));
    const before = sampler.readings().length;
    sampler.stop(false);
    for (let index = 0; index < 3; index += 1) {
      runFrame();
    }
    expect(sampler.readings()).toHaveLength(before);
  });

  it('prints the summary when the sampling window elapses', () => {
    const { element } = fakePane();
    const printed: string[] = [];
    const sampler = createFrameVisibilitySampler((message) => printed.push(message));
    sampler.start(element, 5);
    runFrame();

    jest.advanceTimersByTime(5000);
    expect(printed.join('\n')).toContain('per-frame visibility sample');
    expect(printed.join('\n')).toContain('late ');
    expect(printed.join('\n')).toContain('BEFORE its paint');
  });
});

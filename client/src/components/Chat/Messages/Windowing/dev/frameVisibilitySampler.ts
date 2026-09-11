/**
 * Development-only per-frame visibility sampler for the Stage 2 browser gate.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md` §22.1 ("no blank row entering the
 * viewport"). Context: `ai-reports/12-stage-2-provider-infrastructure.md` §12.8, where the
 * provider's own counters read zero while the reader still saw blank frames.
 *
 * **Why a second instrument is needed.** The provider's blank-frame counter is both
 * after-the-fact and all-or-nothing: `blankViewportPasses` is recorded only when *no* mounted
 * row intersects the viewport at pass time *and* the pass mounted nothing (`runGeometryPass`
 * in `ContentRowWindowingContext.tsx`). A paint showing two real rows and five empty
 * placeholder bands scores as "no blank" while a reader plainly sees gaps, because a
 * placeholder is an empty div carrying only an inline height and no background
 * (`client/src/style.css`) — visually it *is* blank background.
 *
 * This sampler measures what is on screen by hit-testing real points inside the scroll pane
 * instead of reasoning from the provider's bookkeeping. Nine probe points down the middle of
 * the pane are classified by `document.elementFromPoint` as real content, placeholder (a
 * correctly sized but empty box, i.e. blank), or background (inter-row margin, the pane's own
 * padding, or the filler after the last row — normal, not a defect).
 *
 * ## Three phases, and why the middle one is the verdict
 *
 * The HTML "update the rendering" order is: scroll steps → animation frame callbacks →
 * intersection observer steps → layout → paint. So a reading taken from an
 * `requestAnimationFrame` callback that was registered *in a scroll listener* is ordered
 * after any pass that listener's siblings registered, and before this frame's paint:
 *
 * - `raf`  — sampled from the sampler's own frame loop. It was registered during the
 *   *previous* frame, so it runs *before* a scroll-triggered pass for this frame. Low
 *   coverage here therefore proves nothing: the provider may be about to mount the very rows
 *   that are missing, in this same paint.
 * - `late` — sampled from an `requestAnimationFrame` registered inside a scroll listener that
 *   is added *after* the provider's (the provider registers its listener at mount; the
 *   sampler registers its own when sampling starts, so it runs second in the same event
 *   dispatch). This reading is taken after this frame's scroll pass, before the paint. **A
 *   zero-content `late` reading is a frame the reader saw blank.** For the deferred pass path
 *   this is the only channel that can tell the two §12.8 explanations apart.
 * - `post` — sampled from a `setTimeout(0)` scheduled by the `raf` phase, so nominally after
 *   the frame was committed. Kept because it is the cheap approximation of "on screen", but
 *   it is *not* trustworthy as a negative: if the main thread was busy, it can run after the
 *   next frame's mounts and report content for a frame that painted blank.
 */

/** What a probe point landed on. `background` is normal page furniture, not a defect. */
export type FrameVisibilityHit = 'mounted' | 'placeholder' | 'background';

/** When a reading was taken relative to this frame's paint. */
export type FrameVisibilityPhase = 'raf' | 'late' | 'post';

/** Vertical extent of the row shells currently in the document, in viewport coordinates. */
export type FrameVisibilityBand = { top: number; bottom: number } | null;

/** One reading of the scroll pane's visible strip. */
export type FrameVisibilityReading = {
  t: number;
  scrollTop: number;
  scrollHeight: number;
  /** Probe points inside a row whose real content is rendered. */
  contentPoints: number;
  /** Probe points inside a placeholder: a correctly sized but empty box, i.e. blank. */
  placeholderPoints: number;
  /** Probe points on margins, padding, or filler — reported, never counted against coverage. */
  backgroundPoints: number;
  /** Content + placeholder points: the share of the strip that is inside a row shell. */
  bandPoints: number;
  /** `contentPoints / bandPoints`. Vacuously 1 when the strip holds no row shells at all. */
  coverage: number;
  /** Longest run of adjacent background points, in points. >= 3 means a real hole, not a margin. */
  longestBackgroundRun: number;
  center: FrameVisibilityHit;
  mountedRows: number;
  placeholderRows: number;
};

export type FrameVisibilitySample = FrameVisibilityReading & {
  /** Index of the animation frame this reading belongs to; pairs the phases. */
  frame: number;
  phase: FrameVisibilityPhase;
  /** Signed `scrollTop` change since the previous frame's `raf` reading. */
  scrollDelta: number;
  /** Scroll events delivered since the previous frame's `raf` reading. */
  scrollEvents: number;
};

export const FRAME_VISIBILITY_PROBE_POINTS = 9;

/** A run this long inside the row band is a hole in the document, not an inter-row margin. */
export const FRAME_VISIBILITY_HOLE_RUN = 3;

/** Sampling is bounded so a forgotten sampler cannot grow the heap without limit. */
export const FRAME_VISIBILITY_MAX_SAMPLES = 6000;

/**
 * Hit-test one point. A point that lands on background inside the row band is reported as
 * `background`; distinguishing a margin from a hole is done by run length, not per point,
 * because an 8px inter-row margin is normal and must not read as a missing row.
 */
export function classifyFrameVisibilityPoint(x: number, y: number): FrameVisibilityHit {
  if (typeof document.elementFromPoint !== 'function') {
    return 'background';
  }
  const element = document.elementFromPoint(x, y);
  if (!element) {
    return 'background';
  }
  const row = element.closest('[data-content-virtual-row="true"]');
  if (!row) {
    return 'background';
  }
  return row.getAttribute('data-content-mounted') === 'true' ? 'mounted' : 'placeholder';
}

/**
 * The row band: from the first row shell's top to the last one's bottom. Rows are in document
 * order, so two rect reads are enough, and the pane's own padding and the filler after the
 * last row are correctly excluded.
 */
export function readRowBand(pane: HTMLElement): FrameVisibilityBand {
  const rows = pane.querySelectorAll('[data-content-virtual-row="true"]');
  if (rows.length === 0) {
    return null;
  }
  const first = rows[0].getBoundingClientRect();
  const last = rows[rows.length - 1].getBoundingClientRect();
  return { top: first.top, bottom: last.bottom };
}

function longestRun(values: readonly boolean[]): number {
  let longest = 0;
  let current = 0;
  values.forEach((value) => {
    current = value ? current + 1 : 0;
    longest = Math.max(longest, current);
  });
  return longest;
}

/** Read one strip. `top`/`bottom` are the pane's visible bounds in window coordinates. */
export function readFrameVisibility(
  pane: HTMLElement,
  top: number,
  bottom: number,
  band: FrameVisibilityBand = readRowBand(pane),
): FrameVisibilityReading {
  const rect = pane.getBoundingClientRect();
  const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
  const span = bottom - top;
  const middle = Math.floor(FRAME_VISIBILITY_PROBE_POINTS / 2);
  let contentPoints = 0;
  let placeholderPoints = 0;
  let backgroundPoints = 0;
  let center: FrameVisibilityHit = 'background';
  const isBackground: boolean[] = [];

  for (let index = 0; index < FRAME_VISIBILITY_PROBE_POINTS; index += 1) {
    const y = top + ((index + 0.5) / FRAME_VISIBILITY_PROBE_POINTS) * span;
    // Outside the row band there is nothing to cover: padding above the first row, filler
    // below the last one. That is page furniture, not a missing row.
    const hit =
      band == null || y < band.top || y > band.bottom
        ? 'background'
        : classifyFrameVisibilityPoint(x, y);
    if (hit === 'mounted') {
      contentPoints += 1;
      isBackground.push(false);
    } else if (hit === 'placeholder') {
      placeholderPoints += 1;
      isBackground.push(false);
    } else {
      backgroundPoints += 1;
      isBackground.push(true);
    }
    if (index === middle) {
      center = hit;
    }
  }

  const bandPoints = contentPoints + placeholderPoints;
  return {
    t: Math.round(performance.now()),
    scrollTop: Math.round(pane.scrollTop),
    scrollHeight: Math.round(pane.scrollHeight),
    contentPoints,
    placeholderPoints,
    backgroundPoints,
    bandPoints,
    // No row shells in the strip: nothing to show, so not a windowing failure.
    coverage: bandPoints === 0 ? 1 : contentPoints / bandPoints,
    longestBackgroundRun: longestRun(isBackground),
    center,
    mountedRows: pane.querySelectorAll(
      '[data-content-virtual-row="true"][data-content-mounted="true"]',
    ).length,
    placeholderRows: pane.querySelectorAll(
      '[data-content-virtual-row="true"][data-content-mounted="false"]',
    ).length,
  };
}

export type FrameVisibilityChannelSummary = {
  phase: FrameVisibilityPhase;
  frames: number;
  coverageMin: number;
  coverageMean: number;
  /** Frames where the visible row band was not entirely real content. */
  incompleteFrames: number;
  /** Frames where the visible row band had no real content at all: the reader saw blank. */
  zeroContentFrames: number;
  /** Frames with a run of background long enough to be a hole rather than a margin. */
  holeFrames: number;
};

export type FrameVisibilitySummary = {
  spanMs: number;
  channels: FrameVisibilityChannelSummary[];
  /** Frames where the scroll offset differed from the previous frame's. */
  offsetArrivals: number;
  /** Of those: the first frame at the new offset had no real content, per channel. */
  arrivalsEmpty: Record<FrameVisibilityPhase, number>;
  /** Longest run of consecutive frames at one offset with the band not fully real. */
  maxCatchUpFrames: number;
  worstLate: FrameVisibilitySample[];
};

function summarizeChannel(
  samples: readonly FrameVisibilitySample[],
  phase: FrameVisibilityPhase,
): FrameVisibilityChannelSummary {
  const coverage = samples.map((sample) => sample.coverage);
  return {
    phase,
    frames: samples.length,
    coverageMin: coverage.length > 0 ? Math.min(...coverage) : 1,
    coverageMean:
      coverage.length > 0
        ? coverage.reduce((total, value) => total + value, 0) / coverage.length
        : 1,
    incompleteFrames: samples.filter((sample) => sample.coverage < 1).length,
    zeroContentFrames: samples.filter(
      (sample) => sample.bandPoints > 0 && sample.contentPoints === 0,
    ).length,
    holeFrames: samples.filter((sample) => sample.longestBackgroundRun >= FRAME_VISIBILITY_HOLE_RUN)
      .length,
  };
}

const worstFirst = (a: FrameVisibilitySample, b: FrameVisibilitySample) =>
  a.contentPoints - b.contentPoints || Math.abs(b.scrollDelta) - Math.abs(a.scrollDelta);

/**
 * How many frames the reader stays at a new offset before the band is fully real content.
 * Independent of event ordering, so it works as a cross-check on the `late` channel.
 */
function catchUpFrames(samples: readonly FrameVisibilitySample[]): number {
  let longest = 0;
  let current = 0;
  let offset: number | null = null;
  samples.forEach((sample) => {
    if (sample.scrollTop !== offset) {
      offset = sample.scrollTop;
      current = sample.coverage < 1 ? 1 : 0;
    } else if (sample.coverage < 1) {
      current += 1;
    } else {
      current = 0;
    }
    longest = Math.max(longest, current);
  });
  return longest;
}

export function summarizeFrameVisibility(
  samples: readonly FrameVisibilitySample[],
  worstCount = 8,
): FrameVisibilitySummary {
  const raf = samples.filter((sample) => sample.phase === 'raf');
  const late = samples.filter((sample) => sample.phase === 'late');
  const post = samples.filter((sample) => sample.phase === 'post');

  let offsetArrivals = 0;
  const arrivalsEmpty: Record<FrameVisibilityPhase, number> = { raf: 0, late: 0, post: 0 };
  const arrivalFrames = new Set<number>();
  raf.forEach((sample, index) => {
    if (index > 0 && sample.scrollTop !== raf[index - 1].scrollTop) {
      offsetArrivals += 1;
      arrivalFrames.add(sample.frame);
    }
  });
  ([late, post, raf] as const).forEach((samples_) =>
    samples_.forEach((sample) => {
      if (arrivalFrames.has(sample.frame) && sample.bandPoints > 0 && sample.contentPoints === 0) {
        arrivalsEmpty[sample.phase] += 1;
      }
    }),
  );

  const spanMs = raf.length > 1 ? raf[raf.length - 1].t - raf[0].t : 0;
  const byPhase: Record<FrameVisibilityPhase, FrameVisibilitySample[]> = { raf, late, post };
  return {
    spanMs: Math.max(0, spanMs),
    channels: (['raf', 'late', 'post'] as const).map((phase) =>
      summarizeChannel(byPhase[phase], phase),
    ),
    offsetArrivals,
    arrivalsEmpty,
    maxCatchUpFrames: catchUpFrames(raf),
    worstLate: late
      .filter((sample) => sample.coverage < 1)
      .slice()
      .sort(worstFirst)
      .slice(0, worstCount),
  };
}

const pointDetail = (sample: FrameVisibilitySample) =>
  'real ' +
  sample.contentPoints +
  ' place ' +
  sample.placeholderPoints +
  ' bg ' +
  sample.backgroundPoints;

export function formatFrameVisibilitySummary(summary: FrameVisibilitySummary): string[] {
  const lines: string[] = [];
  const channel = (phase: FrameVisibilityPhase) =>
    summary.channels.find((entry) => entry.phase === phase) as FrameVisibilityChannelSummary;

  lines.push('===== per-frame visibility sample (dev fixture) =====');
  lines.push(
    'span       ' +
      Math.round(summary.spanMs) +
      'ms   offset arrivals=' +
      summary.offsetArrivals +
      '   longest catch-up at one offset=' +
      summary.maxCatchUpFrames +
      ' frames',
  );
  lines.push('coverage   = share of the VISIBLE ROW BAND that was real row content');
  summary.channels.forEach((entry) => {
    lines.push(
      '  ' +
        entry.phase.padEnd(5) +
        ' frames=' +
        entry.frames +
        '  min=' +
        entry.coverageMin.toFixed(2) +
        '  mean=' +
        entry.coverageMean.toFixed(2) +
        '  incomplete=' +
        entry.incompleteFrames +
        '  ZERO-CONTENT=' +
        entry.zeroContentFrames,
    );
  });
  lines.push(
    '  (hole frames — a background run of ' +
      FRAME_VISIBILITY_HOLE_RUN +
      '+ points, i.e. a missing row rather than a margin: raf=' +
      channel('raf').holeFrames +
      ' late=' +
      channel('late').holeFrames +
      ' post=' +
      channel('post').holeFrames +
      ')',
  );
  lines.push(
    'of the ' +
      summary.offsetArrivals +
      ' frames that arrived at a new scroll offset, empty in: raf=' +
      summary.arrivalsEmpty.raf +
      ' late=' +
      summary.arrivalsEmpty.late +
      ' post=' +
      summary.arrivalsEmpty.post,
  );
  lines.push('--- verdict ---');
  lines.push("late = read AFTER this frame's scroll pass and BEFORE its paint, so it is the state");
  lines.push('the reader was shown. ZERO-CONTENT late frames are frames that painted blank.');
  lines.push('raf is sampled before that pass, so its zeros alone prove nothing.');

  if (summary.worstLate.length === 0) {
    lines.push('worst late frames: none — every scroll frame painted real content in the band');
    return lines;
  }
  lines.push('worst late frames (' + summary.worstLate.length + '):');
  summary.worstLate.forEach((sample) => {
    lines.push(
      '  t=' +
        sample.t +
        'ms  scrollTop=' +
        sample.scrollTop +
        ' (delta ' +
        (sample.scrollDelta >= 0 ? '+' : '') +
        sample.scrollDelta +
        ')  height=' +
        sample.scrollHeight +
        '  [' +
        pointDetail(sample) +
        ']  center=' +
        sample.center +
        '  rows ' +
        sample.mountedRows +
        ' mounted / ' +
        sample.placeholderRows +
        ' placeholder  events=' +
        sample.scrollEvents,
    );
  });
  return lines;
}

export type FrameVisibilitySampler = {
  start: (pane: HTMLElement | null, seconds?: number) => string;
  stop: (print?: boolean) => string;
  readings: () => readonly FrameVisibilitySample[];
};

/**
 * Sample the pane every animation frame, in all three phases, until stopped or until
 * `seconds` elapse. Printing is batched to the end: a per-frame `console.log` would both slow
 * the frame down and bury the signal.
 */
export function createFrameVisibilitySampler(
  log: (message: string) => void = (message) => console.log(message),
): FrameVisibilitySampler {
  let frame: number | null = null;
  let autoStop: ReturnType<typeof setTimeout> | null = null;
  let postTimers: Array<ReturnType<typeof setTimeout>> = [];
  let collected: FrameVisibilitySample[] = [];
  let paneEl: HTMLElement | null = null;
  let onScroll: (() => void) | null = null;
  let lastTop: number | null = null;
  let pendingEvents = 0;
  let frameIndex = 0;
  let lateQueued = false;
  /** Arrival attribution per frame, so `late`/`post` report the frame's own delta and events. */
  const arrivals = new Map<number, { scrollDelta: number; scrollEvents: number }>();

  function release() {
    if (frame != null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (autoStop != null) {
      clearTimeout(autoStop);
      autoStop = null;
    }
    postTimers.forEach((timer) => clearTimeout(timer));
    postTimers = [];
    if (onScroll && paneEl) {
      paneEl.removeEventListener('scroll', onScroll);
    }
    onScroll = null;
    paneEl = null;
  }

  function stop(print = true): string {
    const collectedCount = collected.length;
    const samples = collected;
    release();
    if (print) {
      formatFrameVisibilitySummary(summarizeFrameVisibility(samples)).forEach(log);
    }
    return 'sampling stopped (' + collectedCount + ' readings, ' + samples.length + ' kept)';
  }

  function visibleBounds(pane: HTMLElement) {
    const rect = pane.getBoundingClientRect();
    return {
      top: Math.max(rect.top, 0),
      bottom: Math.min(rect.bottom, window.innerHeight),
    };
  }

  function sample(pane: HTMLElement, phase: FrameVisibilityPhase, index: number) {
    if (collected.length >= FRAME_VISIBILITY_MAX_SAMPLES) {
      return;
    }
    const { top, bottom } = visibleBounds(pane);
    if (bottom - top < 16) {
      return;
    }
    const reading = readFrameVisibility(pane, top, bottom);
    // `late` and `post` describe the same frame as their `raf` sample, so they reuse that
    // frame's arrival. Attributing only on `raf` printed "delta +0 events 0" on every later
    // line, which read as "the page was stationary" while the reader was scrolling hard.
    let scrollDelta = 0;
    let scrollEvents = 0;
    if (phase === 'raf') {
      scrollDelta = lastTop == null ? 0 : reading.scrollTop - lastTop;
      lastTop = reading.scrollTop;
      scrollEvents = pendingEvents;
      pendingEvents = 0;
      arrivals.set(index, { scrollDelta, scrollEvents });
    } else {
      const arrival = arrivals.get(index);
      scrollDelta = arrival?.scrollDelta ?? 0;
      scrollEvents = arrival?.scrollEvents ?? 0;
    }
    collected.push({ ...reading, frame: index, phase, scrollDelta, scrollEvents });

    if (phase === 'raf') {
      const postTimer = setTimeout(() => {
        postTimers = postTimers.filter((timer) => timer !== postTimer);
        const paneNow = paneEl;
        if (paneNow) {
          sample(paneNow, 'post', index);
        }
        arrivals.delete(index);
      }, 0);
      postTimers.push(postTimer);
    }
  }

  function tick() {
    const pane = paneEl;
    if (!pane) {
      frame = null;
      return;
    }
    const index = frameIndex;
    frameIndex += 1;
    sample(pane, 'raf', index);

    if (collected.length >= FRAME_VISIBILITY_MAX_SAMPLES) {
      stop(true);
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function start(pane: HTMLElement | null, seconds = 20): string {
    if (!pane) {
      return 'no scroll pane on this page — is this /dev/content-rows?';
    }
    if (frame != null || autoStop != null) {
      return 'already sampling — call __lcRows.sampleStop() first';
    }
    collected = [];
    frameIndex = 0;
    lastTop = null;
    pendingEvents = 0;
    lateQueued = false;
    arrivals.clear();
    paneEl = pane;
    /**
     * Added after the provider's own scroll listener (the provider registers at mount, this
     * runs when sampling starts), so within one event dispatch this handler runs second. The
     * `requestAnimationFrame` it registers is therefore queued behind the pass the provider's
     * handler registered, and runs after that pass but before the frame is painted.
     */
    onScroll = () => {
      pendingEvents += 1;
      if (lateQueued) {
        return;
      }
      lateQueued = true;
      requestAnimationFrame(() => {
        lateQueued = false;
        // `paneEl` is nulled by release(), so this also discards a callback queued before stop.
        if (paneEl) {
          sample(paneEl, 'late', frameIndex - 1);
        }
      });
    };
    pane.addEventListener('scroll', onScroll, { passive: true });
    frame = requestAnimationFrame(tick);
    autoStop = setTimeout(() => stop(true), Math.max(1, seconds) * 1000);
    return (
      'sampling for ' +
      seconds +
      's — do the provoking action now, keep this window focused, and wait for the summary'
    );
  }

  return {
    start,
    stop,
    readings: () => collected,
  };
}

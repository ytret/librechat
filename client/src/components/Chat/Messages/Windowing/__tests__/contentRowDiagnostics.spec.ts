import {
  CONTENT_ROW_DIAGNOSTICS_GLOBAL_KEY,
  createContentRowDiagnostics,
  createEmptyDiagnosticsLive,
  createLiveDiagnosticsState,
  createKindCountMap,
  createMountStateCountMap,
  createPinReasonCountMap,
  createRejectReasonCountMap,
  installContentRowDiagnostics,
  summarizeFrames,
  summarizeValues,
} from '../contentRowDiagnostics';
import { CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT } from '../contentRowTypes';
import type { ContentRowDiagnosticsSnapshot, ContentRowRecord } from '../contentRowTypes';

const live = () => createEmptyDiagnosticsLive();

const detail = (debugKey: string) => ({
  debugKey,
  kind: 'markdown' as const,
  elapsedMs: 2000,
  reason: 'budget-expired' as const,
});

describe('summarizeValues', () => {
  it('returns nulls for an empty list rather than zeros or NaN', () => {
    expect(summarizeValues([])).toEqual({
      count: 0,
      total: 0,
      min: null,
      max: null,
      mean: null,
      p50: null,
      p95: null,
    });
  });

  it('reports count, total, min, max, and mean', () => {
    const stats = summarizeValues([10, 20, 30, 40]);
    expect(stats.count).toBe(4);
    expect(stats.total).toBe(100);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(40);
    expect(stats.mean).toBe(25);
  });

  it('uses nearest-rank percentiles, matching the stage 0 trace harness on a single value', () => {
    const stats = summarizeValues([7]);
    expect(stats.p50).toBe(7);
    expect(stats.p95).toBe(7);
  });

  it('matches the harness percentile convention on a known series', () => {
    // nearest-rank: p50 of 1..100 is the 50th value, p95 the 95th
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    const stats = summarizeValues(values);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    summarizeValues(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('summarizeFrames', () => {
  it('reports zero frames without dividing by zero', () => {
    expect(summarizeFrames([])).toEqual({ frames: 0, total: 0, max: 0, mean: null });
  });

  it('counts frames, total, max, and mean including zero-activity frames', () => {
    expect(summarizeFrames([0, 4, 2])).toEqual({ frames: 3, total: 6, max: 4, mean: 2 });
  });
});

describe('count maps', () => {
  it('starts every key at zero so snapshots never have missing kinds', () => {
    expect(Object.values(createKindCountMap()).every((value) => value === 0)).toBe(true);
    expect(Object.values(createMountStateCountMap()).every((value) => value === 0)).toBe(true);
    expect(Object.values(createRejectReasonCountMap()).every((value) => value === 0)).toBe(true);
    expect(Object.values(createPinReasonCountMap()).every((value) => value === 0)).toBe(true);
    expect(createKindCountMap()).toHaveProperty('parallel-section');
    expect(createMountStateCountMap()).toHaveProperty('PLACEHOLDER_MEASURED');
    expect(createRejectReasonCountMap()).toHaveProperty('fingerprint-mismatch');
    expect(createPinReasonCountMap()).toHaveProperty('selection');
  });
});

describe('diagnostics collector', () => {
  it('merges live registry state into the snapshot', () => {
    const collector = createContentRowDiagnostics();
    const snapshot = collector.snapshot({
      ...live(),
      registeredRows: 6,
      mountedRows: 2,
      placeholderRows: 4,
    });
    expect(snapshot.registeredRows).toBe(6);
    expect(snapshot.mountedRows).toBe(2);
    expect(snapshot.placeholderRows).toBe(4);
  });

  it('counts registrations, unregistrations, and accepted measurements by source', () => {
    const collector = createContentRowDiagnostics();
    collector.recordRegistration(3);
    collector.recordUnregistration(1);
    collector.recordAcceptedMeasurement('layout-effect');
    collector.recordAcceptedMeasurement('resize-observer');
    collector.recordAcceptedMeasurement('resize-observer');
    const snapshot = collector.snapshot(live());
    expect(snapshot.registrations).toBe(3);
    expect(snapshot.unregistrations).toBe(1);
    expect(snapshot.acceptedMeasurements).toBe(3);
    expect(snapshot.acceptedMeasurementsBySource).toEqual({
      'layout-effect': 1,
      'resize-observer': 2,
    });
  });

  it('records rejections by reason and totals them', () => {
    const collector = createContentRowDiagnostics();
    collector.recordRejectedMeasurement('generation-mismatch');
    collector.recordRejectedMeasurement('generation-mismatch');
    collector.recordRejectedMeasurement('not-mounted');
    const snapshot = collector.snapshot(live());
    expect(snapshot.rejectedByReason['generation-mismatch']).toBe(2);
    expect(snapshot.rejectedByReason['not-mounted']).toBe(1);
    expect(snapshot.rejectedByReason['bucket-mismatch']).toBe(0);
    expect(snapshot.rejectedMeasurements).toBe(3);
  });

  it('defaults the stale-acceptance counter to zero, the Stage 2 gate value', () => {
    const collector = createContentRowDiagnostics();
    collector.recordAcceptedMeasurement('layout-effect');
    expect(collector.snapshot(live()).staleMeasurementsAccepted).toBe(0);
    collector.recordStaleMeasurementAccepted();
    expect(collector.snapshot(live()).staleMeasurementsAccepted).toBe(1);
  });

  it('tracks current pins per reason, incrementing and decrementing symmetrically', () => {
    const collector = createContentRowDiagnostics();
    collector.recordPin('selection');
    collector.recordPin('selection');
    collector.recordPin('focus');
    collector.recordUnpin('selection');
    const snapshot = collector.snapshot(live());
    expect(snapshot.pinsByReason.selection).toBe(1);
    expect(snapshot.pinsByReason.focus).toBe(1);
    expect(snapshot.pinsByReason.navigation).toBe(0);
  });

  it('never lets an unpin drive a pin count negative', () => {
    const collector = createContentRowDiagnostics();
    collector.recordUnpin('focus');
    expect(collector.snapshot(live()).pinsByReason.focus).toBe(0);
  });

  it('summarizes mount batches, including zero-displacement batches', () => {
    const collector = createContentRowDiagnostics();
    collector.recordMountBatch({
      id: 1,
      mounts: 4,
      unmounts: 0,
      durationMs: 18,
      anchorDisplacement: 1.5,
      anchorCorrection: 1.5,
    });
    collector.recordMountBatch({
      id: 2,
      mounts: 0,
      unmounts: 3,
      durationMs: 4,
      anchorDisplacement: 0,
      anchorCorrection: 0,
    });
    const snapshot = collector.snapshot(live());
    expect(snapshot.mountCountsPerFrame).toEqual({ frames: 2, total: 4, max: 4, mean: 2 });
    expect(snapshot.unmountCountsPerFrame).toEqual({ frames: 2, total: 3, max: 3, mean: 1.5 });
    expect(snapshot.mountTransactionDurations.max).toBe(18);
    expect(snapshot.anchorDisplacement.max).toBe(1.5);
    expect(snapshot.anchorCorrection.count).toBe(2);
  });

  it('counts viewport budget bypasses and over-budget corrections separately', () => {
    const collector = createContentRowDiagnostics();
    collector.recordViewportBypass(2);
    collector.recordViewportBypass(1);
    collector.recordOverBudgetCorrection();
    const snapshot = collector.snapshot(live());
    expect(snapshot.viewportBudgetBypass).toBe(3);
    expect(snapshot.overBudgetCorrections).toBe(1);
  });

  it('records and bounds timeout details so diagnostics cannot grow without limit', () => {
    const collector = createContentRowDiagnostics();
    for (let index = 0; index < CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT + 5; index++) {
      collector.recordSettleTimeout(detail(`row-${index}`));
    }
    collector.recordReadinessTimeout(detail('async-row'));
    collector.recordMaterializeTimeout('screenshot');
    const snapshot = collector.snapshot(live());
    expect(snapshot.settlementTimeouts).toBe(CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT + 5);
    expect(snapshot.settlementTimeoutDetails).toHaveLength(CONTENT_ROW_DIAGNOSTICS_DETAIL_LIMIT);
    // oldest entries are dropped first
    expect(snapshot.settlementTimeoutDetails[0].debugKey).toBe('row-5');
    expect(snapshot.readinessTimeoutDetails).toHaveLength(1);
    expect(snapshot.materializationTimeoutDetails).toEqual(['screenshot']);
  });

  it('tracks warm-up duration and completion', () => {
    const collector = createContentRowDiagnostics();
    expect(collector.snapshot(live()).warmUpComplete).toBe(false);
    collector.startWarmUp(1000);
    expect(collector.snapshot(live()).warmUpDurationMs).toBeNull();
    collector.completeWarmUp(1350);
    const snapshot = collector.snapshot(live());
    expect(snapshot.warmUpComplete).toBe(true);
    expect(snapshot.warmUpDurationMs).toBe(350);
  });

  it('keeps the bucket and reflow state supplied by the provider, not a stale copy', () => {
    const collector = createContentRowDiagnostics();
    const snapshot = collector.snapshot({
      ...live(),
      layoutBucket: 'w50-f32-markdown',
      reflowState: 'reflow-materialized',
    });
    expect(snapshot.layoutBucket).toBe('w50-f32-markdown');
    expect(snapshot.reflowState).toBe('reflow-materialized');
  });

  it('returns copies so a caller cannot mutate collector state through a snapshot', () => {
    const collector = createContentRowDiagnostics();
    collector.recordRejectedMeasurement('no-record');
    const snapshot = collector.snapshot(live());
    snapshot.rejectedByReason['no-record'] = 999;
    snapshot.settlementTimeoutDetails.push(detail('injected'));
    expect(collector.snapshot(live()).rejectedByReason['no-record']).toBe(1);
    expect(collector.snapshot(live()).settlementTimeoutDetails).toHaveLength(0);
  });

  it('resets every counter to its initial value', () => {
    const collector = createContentRowDiagnostics();
    collector.recordRegistration();
    collector.recordRejectedMeasurement('no-record');
    collector.recordPin('focus');
    collector.recordSettleTimeout(detail('row'));
    collector.recordMountBatch({
      id: 3,
      mounts: 1,
      unmounts: 1,
      durationMs: 1,
      anchorDisplacement: 3,
      anchorCorrection: 3,
    });
    collector.startWarmUp(0);
    collector.completeWarmUp(10);
    collector.reset();
    expect(collector.snapshot(live())).toEqual(
      expect.objectContaining({
        registrations: 0,
        unregistrations: 0,
        acceptedMeasurements: 0,
        rejectedMeasurements: 0,
        staleMeasurementsAccepted: 0,
        settlementTimeouts: 0,
        settlementTimeoutDetails: [],
        readinessTimeouts: 0,
        materializationTimeouts: 0,
        overBudgetCorrections: 0,
        viewportBudgetBypass: 0,
        warmUpDurationMs: null,
        warmUpComplete: false,
      }),
    );
    expect(collector.snapshot(live()).pinsByReason.focus).toBe(0);
    expect(collector.snapshot(live()).mountCountsPerFrame).toEqual({
      frames: 0,
      total: 0,
      max: 0,
      mean: null,
    });
  });

  it('produces a snapshot with every documented §23 section present', () => {
    const snapshot: ContentRowDiagnosticsSnapshot = createContentRowDiagnostics().snapshot(live());
    for (const key of [
      'registeredRows',
      'mountedRows',
      'placeholderRows',
      'unmeasuredRows',
      'unsettledRows',
      'staleRows',
      'oversizedRows',
      'alwaysMountedRows',
      'totalByKind',
      'mountedByKind',
      'mountStates',
      'measuredHeightDistribution',
      'pinsByReason',
      'settlementTimeoutDetails',
      'mountCountsPerFrame',
      'unmountCountsPerFrame',
      'mountTransactionDurations',
      'anchorDisplacement',
      'anchorCorrection',
      'rejectedByReason',
      'staleMeasurementsAccepted',
      'warmUpDurationMs',
      'reflowState',
    ]) {
      expect(snapshot).toHaveProperty(key);
    }
  });
});

describe('installContentRowDiagnostics', () => {
  const original = window.__lcContentRows;

  afterEach(() => {
    window.__lcContentRows = original;
  });

  it('installs a console handle in development and removes it on uninstall', () => {
    const collector = createContentRowDiagnostics();
    const uninstall = installContentRowDiagnostics(collector, {
      isDevelopment: true,
      getLive: () => ({ ...live(), registeredRows: 7 }),
    });
    expect(window[CONTENT_ROW_DIAGNOSTICS_GLOBAL_KEY]).toBeDefined();
    expect(window.__lcContentRows?.snapshot().registeredRows).toBe(7);
    window.__lcContentRows?.reset();
    uninstall();
    expect(window.__lcContentRows).toBeUndefined();
  });

  it('installs nothing in production builds, so diagnostics cannot leak in a release', () => {
    const collector = createContentRowDiagnostics();
    const uninstall = installContentRowDiagnostics(collector, {
      isDevelopment: false,
      getLive: live,
    });
    expect(window.__lcContentRows).toBeUndefined();
    expect(() => uninstall()).not.toThrow();
  });

  it('uninstall only clears the handle when it is still the active one', () => {
    const first = createContentRowDiagnostics();
    const second = createContentRowDiagnostics();

    const uninstallFirst = installContentRowDiagnostics(first, {
      isDevelopment: true,
      getLive: () => ({ ...live(), registeredRows: 1 }),
    });
    installContentRowDiagnostics(second, {
      isDevelopment: true,
      getLive: () => ({ ...live(), registeredRows: 2 }),
    });

    // the superseded handle must not clear the live one
    uninstallFirst();
    expect(window.__lcContentRows?.snapshot().registeredRows).toBe(2);
  });
});

describe('createLiveDiagnosticsState', () => {
  const record = (overrides: Partial<ContentRowRecord> = {}): ContentRowRecord =>
    ({
      token: Symbol('row'),
      scopeToken: Symbol('scope'),
      messageId: 'm1',
      debugKey: 'm1:markdown:0',
      kind: 'markdown',
      fingerprint: 'markdown|0',
      measuredFingerprint: 'markdown|0',
      policy: 'windowed',
      shellElement: null,
      measuredElement: null,
      mounted: true,
      committedMounted: true,
      generation: 1,
      layoutBucket: 'w50-f32-markdown',
      measuredHeight: undefined,
      mountState: 'MOUNTED_UNMEASURED',
      settled: false,
      forceMounted: false,
      oversized: false,
      pinnedByPolicy: null,
      pins: new Set(),
      setMounted: () => {},
      commitWaiters: new Set(),
      ...overrides,
    }) as ContentRowRecord;

  const state = { layoutBucket: 'w50-f32-markdown', reflowState: 'idle' as const };

  it('reports an empty registry without inventing rows', () => {
    const live = createLiveDiagnosticsState([], state);
    expect(live).toEqual(
      expect.objectContaining({
        registeredRows: 0,
        mountedRows: 0,
        placeholderRows: 0,
        unmeasuredRows: 0,
        unsettledRows: 0,
        staleRows: 0,
      }),
    );
    expect(live.measuredHeightDistribution.count).toBe(0);
  });

  it('splits mounted from placeholder rows and counts them per kind', () => {
    const live = createLiveDiagnosticsState(
      [
        record({ kind: 'markdown' }),
        record({ kind: 'markdown', mounted: false, mountState: 'PLACEHOLDER_MEASURED' }),
        record({ kind: 'image' }),
      ],
      state,
    );
    expect(live.registeredRows).toBe(3);
    expect(live.mountedRows).toBe(2);
    expect(live.placeholderRows).toBe(1);
    expect(live.totalByKind.markdown).toBe(2);
    expect(live.totalByKind.image).toBe(1);
    expect(live.mountedByKind.markdown).toBe(1);
    expect(live.mountedByKind.image).toBe(1);
    expect(live.mountStates.PLACEHOLDER_MEASURED).toBe(1);
    expect(live.mountStates.MOUNTED_UNMEASURED).toBe(2);
  });

  it('counts unmeasured, unsettled, forced, oversized, and always-mounted rows', () => {
    const live = createLiveDiagnosticsState(
      [
        record({ measuredHeight: 100, settled: true, mountState: 'MOUNTED_MEASURED_SETTLED' }),
        record({ measuredHeight: 200, settled: false, mountState: 'MOUNTED_MEASURED_UNSETTLED' }),
        record({ measuredHeight: undefined }),
        record({ forceMounted: true, measuredHeight: 50, settled: true }),
        record({ oversized: true, measuredHeight: 5000, settled: true }),
        record({ policy: 'always-mounted', measuredHeight: 75, settled: true }),
        record({ pinnedByPolicy: 'debug', measuredHeight: 75, settled: true }),
      ],
      state,
    );
    expect(live.unmeasuredRows).toBe(1);
    expect(live.unsettledRows).toBe(2);
    expect(live.forcedRows).toBe(1);
    expect(live.oversizedRows).toBe(1);
    // policy always-mounted + pinnedByPolicy
    expect(live.alwaysMountedRows).toBe(2);
  });

  it('flags a row that still holds a height under a mismatched fingerprint as stale', () => {
    const live = createLiveDiagnosticsState(
      [
        record({ measuredFingerprint: 'markdown|0|expanded', measuredHeight: 180 }),
        // a mismatched capture with no height held is unmeasured, not stale
        record({ measuredFingerprint: 'markdown|0|expanded' }),
        record({ measuredHeight: 180 }),
      ],
      state,
    );
    expect(live.staleRows).toBe(1);
  });

  it('summarizes the measured heights instead of exposing the raw list', () => {
    const live = createLiveDiagnosticsState(
      [record({ measuredHeight: 100 }), record({ measuredHeight: 300 }), record()],
      state,
    );
    expect(live.measuredHeightDistribution).toEqual({
      count: 2,
      total: 400,
      min: 100,
      max: 300,
      mean: 200,
      p50: 100,
      p95: 300,
    });
  });

  it('carries the bucket and reflow state through, including the reflow-materialized mode', () => {
    const live = createLiveDiagnosticsState([], {
      layoutBucket: 'w40-f32-plain',
      reflowState: 'reflow-materialized',
    });
    expect(live.layoutBucket).toBe('w40-f32-plain');
    expect(live.reflowState).toBe('reflow-materialized');
  });
});

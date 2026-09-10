import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContentRowWindowingProvider, useContentRowWindowing } from '../ContentRowWindowingContext';
import { VirtualizedContentRow } from '../VirtualizedContentRow';
import {
  isContentRowWindowingEnabled,
  setContentRowWindowingEnabled,
} from '../contentRowFeatureFlag';
import { createRowToken } from '../contentRowIdentity';
import type { ContentRowDiagnosticsSnapshot, ContentRowKind } from '../contentRowTypes';

/**
 * Development-only acceptance harness for content-row windowing (Stage 2 task 2.7).
 *
 * Reachable at `/dev/content-rows` in development builds only. It has its own scroll
 * container rather than the chat's, so the fling / scrollbar-drag / elastic-bounce matrix can
 * be exercised without a conversation or a session.
 *
 * Every control maps to something a later stage depends on: the flag toggle is the Stage 5
 * rollback, the overlay is the §23 diagnostics snapshot, and the synthetic rows cover the
 * cases Stages 3–4 will wrap for real (bounded blocks, known-size images, asynchronous
 * renderers, never-settling geometry, oversized content, and expansion state).
 */

export type RowSpec = {
  id: string;
  kind: ContentRowKind;
  height: number;
  /** Simulates content that changes size after it was measured. */
  growth?: number;
  /** Registers a real readiness barrier that resolves after this delay (§8.2). */
  readyAfterMs?: number;
  /** Keeps changing size, so it can never settle and must be demoted (§8.1). */
  neverSettles?: boolean;
  label: string;
};

const KIND_CYCLE: ContentRowKind[] = ['markdown', 'summary', 'generic', 'reasoning', 'image'];

export function buildRows(count: number, seed: number): RowSpec[] {
  return Array.from({ length: count }, (_, index) => {
    const kind = KIND_CYCLE[(index + seed) % KIND_CYCLE.length];
    const neverSettles = kind === 'reasoning' && index % 7 === 3;
    return {
      id: `row-${seed}-${index}`,
      kind,
      height: kind === 'image' ? 220 : 120 + (index % 5) * 60,
      growth: index % 11 === 5 ? 60 : undefined,
      readyAfterMs: kind === 'image' ? 400 : undefined,
      neverSettles,
      label: `${kind} ${index}`,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* One synthetic row                                                          */
/* -------------------------------------------------------------------------- */

export function SyntheticRow({
  spec,
  expanded,
  alwaysMounted,
  onToggleExpanded,
  onToggleAlwaysMounted,
}: {
  spec: RowSpec;
  expanded: boolean;
  alwaysMounted: boolean;
  onToggleExpanded: (id: string) => void;
  onToggleAlwaysMounted: (id: string) => void;
}) {
  const windowing = useContentRowWindowing();
  const token = useRef(createRowToken(spec.id));
  const [generation, setGeneration] = useState(1);
  const [grown, setGrown] = useState(false);
  const [ready, setReady] = useState(!spec.readyAfterMs);

  // An asynchronous renderer: it registers a real barrier for the generation it belongs to
  // and resolves it when its content is final (§8.2). Resolving on cleanup means an
  // unmounted renderer never leaves its row unsettled forever.
  useEffect(() => {
    if (!spec.readyAfterMs) {
      return;
    }
    let settled = false;
    let resolveBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
    });
    const unsubscribe = windowing.registerReadiness(token.current, generation, barrier);
    setReady(false);
    const timer = setTimeout(() => {
      setReady(true);
      resolveBarrier();
    }, spec.readyAfterMs);
    return () => {
      clearTimeout(timer);
      resolveBarrier();
      unsubscribe();
    };
  }, [windowing, generation, spec.readyAfterMs]);

  // Content that grows after it was measured: the placeholder must keep the measured height,
  // so the transition back to real content has to be corrected rather than jump.
  useEffect(() => {
    if (!spec.growth) {
      return;
    }
    const timer = setTimeout(() => setGrown(true), 1500);
    return () => clearTimeout(timer);
  }, [spec.growth]);

  // Geometry that never stops changing: the row cannot settle and must be demoted to an
  // effective always-mounted policy instead of ever becoming a placeholder.
  useEffect(() => {
    if (!spec.neverSettles) {
      return;
    }
    const interval = setInterval(() => setGrown((value) => !value), 120);
    return () => clearInterval(interval);
  }, [spec.neverSettles]);

  const height = spec.height + (grown ? (spec.growth ?? 40) : 0);

  return (
    <VirtualizedContentRow
      messageId="dev-fixture"
      kind={spec.kind}
      sourceKey={spec.id}
      stateKey={expanded ? 'expanded' : 'collapsed'}
      ordinal={Number(spec.id.split('-').pop())}
      policy={alwaysMounted ? 'always-mounted' : 'windowed'}
      className="mb-2"
      onGenerationChange={setGeneration}
    >
      <div
        className="flex flex-col gap-1 rounded p-2 text-xs"
        style={{
          height,
          background: alwaysMounted ? '#3b2f00' : '#1f2937',
          border: '1px solid #374151',
          color: '#e5e7eb',
        }}
      >
        <div className="flex items-center gap-2">
          <strong>{spec.label}</strong>
          <span style={{ opacity: 0.7 }}>{height}px</span>
          {spec.neverSettles ? <span>never settles</span> : null}
          {spec.readyAfterMs ? <span>{ready ? 'ready' : 'pending'}</span> : null}
          {spec.growth ? <span>grows</span> : null}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => onToggleExpanded(spec.id)}>
            {expanded ? 'collapse' : 'expand'}
          </button>
          <button type="button" onClick={() => onToggleAlwaysMounted(spec.id)}>
            {alwaysMounted ? 'windowed' : 'always mounted'}
          </button>
        </div>
        {expanded ? (
          <div>
            Expansion state is owned above the row, so expansion alone must not permanently pin
            historical DOM (invariant 11).
          </div>
        ) : null}
      </div>
    </VirtualizedContentRow>
  );
}

/* -------------------------------------------------------------------------- */
/* Fixture shell                                                              */
/* -------------------------------------------------------------------------- */

const METRICS: Array<[string, (snapshot: ContentRowDiagnosticsSnapshot) => React.ReactNode]> = [
  ['rows', (s) => s.registeredRows],
  ['mounted', (s) => s.mountedRows],
  ['placeholders', (s) => s.placeholderRows],
  ['unmeasured', (s) => s.unmeasuredRows],
  ['unsettled', (s) => s.unsettledRows],
  ['stale', (s) => s.staleRows],
  ['always-mounted', (s) => s.alwaysMountedRows],
  ['oversized', (s) => s.oversizedRows],
  ['accepted', (s) => s.acceptedMeasurements],
  ['rejected', (s) => s.rejectedMeasurements],
  ['stale accepted', (s) => s.staleMeasurementsAccepted],
  ['over-budget corrections', (s) => s.overBudgetCorrections],
  ['settle timeouts', (s) => s.settlementTimeouts],
  ['readiness timeouts', (s) => s.readinessTimeouts],
  ['materialize timeouts', (s) => s.materializationTimeouts],
  ['viewport bypass', (s) => s.viewportBudgetBypass],
  ['warm-up ms', (s) => s.warmUpDurationMs],
  ['warm-up complete', (s) => String(s.warmUpComplete)],
  ['bucket', (s) => s.layoutBucket ?? '—'],
  ['reflow', (s) => s.reflowState],
  ['mounts/frame max', (s) => s.mountCountsPerFrame.max],
  ['unmounts/frame max', (s) => s.unmountCountsPerFrame.max],
  ['max displacement px', (s) => s.anchorDisplacement.max],
  ['max correction px', (s) => s.anchorCorrection.max],
  ['max async correction px', (s) => s.asyncCorrection.max],
  ['max transaction ms', (s) => s.mountTransactionDurations.max],
  ['max height px', (s) => s.measuredHeightDistribution.max],
  ['p50 height px', (s) => s.measuredHeightDistribution.p50],
];

const display = (value: React.ReactNode) =>
  typeof value === 'number' ? String(Math.round(value * 10) / 10) : value;

function FixtureBody({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const windowing = useContentRowWindowing();
  const [rowCount, setRowCount] = useState(80);
  const [seed, setSeed] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [alwaysMounted, setAlwaysMounted] = useState<ReadonlySet<string>>(new Set());
  const [snapshot, setSnapshot] = useState<ContentRowDiagnosticsSnapshot | null>(null);
  const [domCount, setDomCount] = useState(0);

  const rows = useMemo(() => buildRows(rowCount, seed), [rowCount, seed]);

  const refresh = useCallback(() => {
    setSnapshot(windowing.getDiagnostics());
    setDomCount(document.getElementsByTagName('*').length);
  }, [windowing]);

  useEffect(() => {
    const interval = setInterval(refresh, 250);
    return () => clearInterval(interval);
  }, [refresh]);

  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    return next;
  };

  const remountStress = useCallback(() => setSeed((value) => value + 1), []);

  const materialize = useCallback(async () => {
    const restore = await windowing.materializeAll('debug');
    restore();
    refresh();
  }, [refresh, windowing]);

  return (
    <div className="flex h-screen w-full" style={{ background: '#0b1220', color: '#e5e7eb' }}>
      <aside
        className="w-80 shrink-0 overflow-y-auto p-3 text-xs"
        style={{ borderRight: '1px solid #374151' }}
      >
        <h1 className="mb-2 text-sm font-bold">Content-row windowing fixture</h1>
        <p className="mb-3" style={{ opacity: 0.7 }}>
          Development only. With the flag off every row is a plain always-mounted block.
        </p>

        <label className="mb-2 flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="flag-toggle"
            checked={isContentRowWindowingEnabled()}
            onChange={(event) => {
              setContentRowWindowingEnabled(event.target.checked);
              refresh();
            }}
          />
          windowing enabled
        </label>

        <div className="my-2 flex flex-wrap gap-2">
          <button type="button" onClick={() => setRowCount((value) => Math.max(10, value - 20))}>
            −20 rows
          </button>
          <button type="button" onClick={() => setRowCount((value) => value + 20)}>
            +20 rows
          </button>
          <button type="button" data-testid="remount-stress" onClick={remountStress}>
            remount stress
          </button>
          <button type="button" data-testid="materialize" onClick={materialize}>
            materializeAll
          </button>
          <button type="button" onClick={() => scrollRef.current?.scrollTo({ top: 0 })}>
            jump top
          </button>
          <button
            type="button"
            onClick={() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })}
          >
            jump bottom
          </button>
        </div>

        <table className="w-full" data-testid="metrics">
          <tbody>
            {snapshot
              ? METRICS.map(([label, select]) => (
                  <tr key={label}>
                    <td style={{ opacity: 0.7 }}>{label}</td>
                    <td className="text-right" data-metric={label}>
                      {display(select(snapshot))}
                    </td>
                  </tr>
                ))
              : null}
            <tr>
              <td style={{ opacity: 0.7 }}>dom elements</td>
              <td className="text-right" data-metric="dom">
                {domCount}
              </td>
            </tr>
          </tbody>
        </table>

        {snapshot ? (
          <div className="mt-3" data-testid="rejected">
            <div style={{ opacity: 0.7 }}>rejected by reason</div>
            {Object.entries(snapshot.rejectedByReason)
              .filter(([, value]) => value > 0)
              .map(([reason, value]) => (
                <div key={reason}>
                  {reason}: {value}
                </div>
              ))}
          </div>
        ) : null}
      </aside>

      <div ref={scrollRef} className="flex-1 overflow-y-auto" data-testid="fixture-scroll">
        <div className="p-3">
          {rows.map((spec) => (
            <SyntheticRow
              key={spec.id}
              spec={spec}
              expanded={expanded.has(spec.id)}
              alwaysMounted={alwaysMounted.has(spec.id)}
              onToggleExpanded={(id) => setExpanded((set) => toggle(set, id))}
              onToggleAlwaysMounted={(id) => setAlwaysMounted((set) => toggle(set, id))}
            />
          ))}
          <div style={{ height: 160 }}>end of fixture</div>
        </div>
      </div>
    </div>
  );
}

export default function ContentRowFixture() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(false);
  return (
    <ContentRowWindowingProvider
      scrollRootRef={scrollRef}
      conversationId="dev-content-rows"
      pinnedToBottomRef={pinnedToBottomRef}
    >
      <FixtureBody scrollRef={scrollRef} />
    </ContentRowWindowingProvider>
  );
}

export { FixtureBody };

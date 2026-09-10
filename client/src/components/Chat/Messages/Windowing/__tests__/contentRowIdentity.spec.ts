import {
  CONTENT_ROW_FONT_BUCKET_STEP,
  CONTENT_ROW_WIDTH_BUCKET_PX,
  classifyMeasurement,
  composeFingerprint,
  computeLayoutBucket,
  createRowToken,
  createScopeToken,
  fingerprintChanged,
  formatDebugKey,
  isAcceptedHeight,
  nextGeneration,
  roundForDiagnostics,
} from '../contentRowIdentity';
import type {
  ContentRowMeasurementTarget,
  ContentRowRejectReason,
  LayoutBucketInput,
} from '../contentRowTypes';

const HEIGHT = 250;
const ELEMENT = document.createElement('div');

const bucketInput = (overrides: Partial<LayoutBucketInput> = {}): LayoutBucketInput => ({
  containerWidth: 800,
  fontSizePx: 16,
  renderingMode: 'markdown',
  ...overrides,
});

function target(overrides: Partial<ContentRowMeasurementTarget> = {}): ContentRowMeasurementTarget {
  return {
    mounted: true,
    measuredElement: ELEMENT,
    generation: 3,
    layoutBucket: 'w50-f32-markdown',
    fingerprint: 'markdown|0',
    measuredFingerprint: 'markdown|0',
    ...overrides,
  };
}

const observation = (
  overrides: Partial<{
    element: HTMLElement | null;
    generation: number;
    layoutBucket: string;
    height: number;
  }> = {},
) => ({
  element: ELEMENT,
  generation: 3,
  layoutBucket: 'w50-f32-markdown',
  height: HEIGHT,
  ...overrides,
});

const rejection = (
  t: ContentRowMeasurementTarget | undefined,
  o: ReturnType<typeof observation>,
) => {
  const verdict = classifyMeasurement(t, o);
  expect(verdict.accepted).toBe(false);
  return (verdict as { accepted: false; reason: ContentRowRejectReason }).reason;
};

describe('contentRowIdentity tokens', () => {
  it('creates unique, non-equal tokens of symbol type', () => {
    const a = createRowToken('a');
    const b = createRowToken('a');
    expect(typeof a).toBe('symbol');
    expect(typeof b).toBe('symbol');
    expect(a).not.toBe(b);
    expect(createScopeToken()).not.toBe(createScopeToken());
  });

  it('uses the debug key only as symbol description, never as identity', () => {
    expect(createRowToken('message-1:markdown:2').description).toBe('message-1:markdown:2');
    expect(createRowToken().description).toBe('content-row');
  });

  it('advances generations monotonically', () => {
    expect(nextGeneration(0)).toBe(1);
    expect(nextGeneration(1)).toBe(2);
    expect(nextGeneration(41)).toBe(42);
  });

  it('formats debug keys without any message content', () => {
    expect(formatDebugKey({ messageId: 'm1', kind: 'markdown', ordinal: 2 })).toBe('m1:markdown:2');
  });
});

describe('computeLayoutBucket', () => {
  it('is stable for changes smaller than the width bucket', () => {
    const base = computeLayoutBucket(bucketInput());
    expect(base).toBe(computeLayoutBucket(bucketInput({ containerWidth: 800 })));
    expect(base).toBe(
      computeLayoutBucket(bucketInput({ containerWidth: 800 + CONTENT_ROW_WIDTH_BUCKET_PX - 1 })),
    );
  });

  it('changes when width crosses a bucket boundary', () => {
    const base = computeLayoutBucket(bucketInput({ containerWidth: 800 }));
    expect(
      computeLayoutBucket(bucketInput({ containerWidth: 800 + CONTENT_ROW_WIDTH_BUCKET_PX })),
    ).not.toBe(base);
  });

  it('changes with font size, UI scale step, and rendering mode', () => {
    const base = computeLayoutBucket(bucketInput());
    expect(
      computeLayoutBucket(bucketInput({ fontSizePx: 16 + CONTENT_ROW_FONT_BUCKET_STEP })),
    ).not.toBe(base);
    expect(computeLayoutBucket(bucketInput({ renderingMode: 'plain' }))).not.toBe(base);
    expect(base).toContain('markdown');
  });

  it('degrades safely for zero, negative, and non-finite widths', () => {
    expect(computeLayoutBucket(bucketInput({ containerWidth: 0 }))).toContain('w0-');
    expect(computeLayoutBucket(bucketInput({ containerWidth: -100 }))).toContain('w0-');
    expect(computeLayoutBucket(bucketInput({ containerWidth: Number.NaN }))).toContain('w0-');
  });
});

describe('fingerprints', () => {
  it('is deterministic and includes kind, source, and state', () => {
    const input = { kind: 'markdown', sourceKey: 0, stateKey: 'collapsed' } as const;
    const value = composeFingerprint(input);
    expect(value).toBe(composeFingerprint(input));
    expect(value).toContain('markdown');
    expect(value).toContain('collapsed');
  });

  it('treats absent, null, and empty state identically', () => {
    const a = composeFingerprint({ kind: 'markdown', sourceKey: 0 });
    const b = composeFingerprint({ kind: 'markdown', sourceKey: 0, stateKey: null });
    const c = composeFingerprint({ kind: 'markdown', sourceKey: 0, stateKey: '' });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('changes when state or content changes, so the old measurement is invalidated', () => {
    const base = composeFingerprint({ kind: 'markdown', sourceKey: 0, stateKey: false });
    expect(
      fingerprintChanged(
        base,
        composeFingerprint({ kind: 'markdown', sourceKey: 0, stateKey: true }),
      ),
    ).toBe(true);
    expect(composeFingerprint({ kind: 'markdown', sourceKey: 0, contentKey: 'v2' })).not.toBe(
      composeFingerprint({ kind: 'markdown', sourceKey: 0, contentKey: 'v1' }),
    );
  });

  it('does not collide across kinds with the same source key', () => {
    expect(composeFingerprint({ kind: 'markdown', sourceKey: 1 })).not.toBe(
      composeFingerprint({ kind: 'tool-group', sourceKey: 1 }),
    );
  });

  it('reports no change for an identical fingerprint and for the undefined case', () => {
    expect(fingerprintChanged('markdown|0', 'markdown|0')).toBe(false);
    expect(fingerprintChanged(undefined, 'markdown|0')).toBe(true);
  });
});

describe('height validation', () => {
  it('accepts finite non-negative numbers including zero', () => {
    expect(isAcceptedHeight(0)).toBe(true);
    expect(isAcceptedHeight(12.5)).toBe(true);
    expect(isAcceptedHeight(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('rejects negative, non-finite, and non-numeric heights', () => {
    expect(isAcceptedHeight(-1)).toBe(false);
    expect(isAcceptedHeight(Number.NaN)).toBe(false);
    expect(isAcceptedHeight(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isAcceptedHeight(undefined)).toBe(false);
    expect(isAcceptedHeight('120')).toBe(false);
    expect(isAcceptedHeight(null)).toBe(false);
  });

  it('rounds only for diagnostics', () => {
    expect(roundForDiagnostics(120.04)).toBe(120);
    expect(roundForDiagnostics(120.06)).toBe(120.1);
    expect(roundForDiagnostics(0)).toBe(0);
  });
});

describe('classifyMeasurement (§12 acceptance rules)', () => {
  it('accepts a fully matching observation', () => {
    expect(classifyMeasurement(target(), observation())).toEqual({ accepted: true });
  });

  it('rejects when no record exists', () => {
    expect(rejection(undefined, observation())).toBe('no-record');
  });

  it('rejects a placeholder shell measurement', () => {
    expect(rejection(target({ mounted: false }), observation())).toBe('not-mounted');
  });

  it('rejects a different element, a missing element, and a missing measured element', () => {
    expect(rejection(target(), observation({ element: document.createElement('div') }))).toBe(
      'element-mismatch',
    );
    expect(rejection(target({ measuredElement: null }), observation())).toBe('element-mismatch');
    expect(rejection(target(), observation({ element: null }))).toBe('element-mismatch');
  });

  it('rejects a stale generation, i.e. a queued callback after remount', () => {
    expect(rejection(target({ generation: 4 }), observation({ generation: 3 }))).toBe(
      'generation-mismatch',
    );
  });

  it('rejects a measurement taken in another layout bucket', () => {
    expect(rejection(target({ layoutBucket: 'w40-f32-markdown' }), observation())).toBe(
      'bucket-mismatch',
    );
  });

  it('rejects when the source changed after the generation started', () => {
    expect(rejection(target({ fingerprint: 'markdown|0|expanded' }), observation())).toBe(
      'fingerprint-mismatch',
    );
    expect(rejection(target({ measuredFingerprint: undefined }), observation())).toBe(
      'fingerprint-mismatch',
    );
  });

  it('rejects an invalid height', () => {
    expect(rejection(target(), observation({ height: -5 }))).toBe('invalid-height');
    expect(rejection(target(), observation({ height: Number.NaN }))).toBe('invalid-height');
  });

  it('checks the rules in spec order, so a multiply-invalid observation reports the first', () => {
    // unmounted + wrong element + wrong generation => not-mounted wins
    expect(
      rejection(
        target({ mounted: false, generation: 9 }),
        observation({ generation: 1, element: document.createElement('div') }),
      ),
    ).toBe('not-mounted');
    // element mismatch wins over generation mismatch
    expect(
      rejection(target({ generation: 9 }), observation({ element: document.createElement('b') })),
    ).toBe('element-mismatch');
  });
});

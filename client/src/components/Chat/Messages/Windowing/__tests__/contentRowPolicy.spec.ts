import { ContentTypes } from 'librechat-data-provider';
import {
  classifyContentRow,
  isOversizedRowHeight,
  windowableContentRowKinds,
} from '../contentRowPolicy';
import { LARGE_ROW_HEIGHT_PX } from '../contentRowTypes';
import type { ContentRowKind, ContentRowPolicy } from '../contentRowTypes';

/**
 * Independent restatement of the §6 Q1/Q4 table from
 * `ai-reports/13-stage-3-conservative-non-text-rows.md`. An exhaustive `Record` here means a
 * new `ContentTypes` member also fails compilation in the test, not only in the source table.
 */
type Expected = {
  kind: ContentRowKind;
  policy: ContentRowPolicy;
  forceMounted: boolean;
};

const EXPECTED_BY_TYPE: Record<ContentTypes, Expected> = {
  [ContentTypes.TEXT]: { kind: 'markdown', policy: 'always-mounted', forceMounted: false },
  [ContentTypes.TEXT_DELTA]: { kind: 'markdown', policy: 'always-mounted', forceMounted: false },
  [ContentTypes.THINK]: { kind: 'reasoning', policy: 'windowed', forceMounted: false },
  [ContentTypes.SUMMARY]: { kind: 'summary', policy: 'windowed', forceMounted: false },
  [ContentTypes.IMAGE_FILE]: {
    kind: 'image',
    policy: 'unstable-until-settled',
    forceMounted: false,
  },
  [ContentTypes.TOOL_CALL]: { kind: 'tool-group', policy: 'always-mounted', forceMounted: false },
  [ContentTypes.ERROR]: { kind: 'generic', policy: 'windowed', forceMounted: false },
  [ContentTypes.AGENT_UPDATE]: { kind: 'generic', policy: 'always-mounted', forceMounted: false },
  [ContentTypes.IMAGE_URL]: { kind: 'generic', policy: 'always-mounted', forceMounted: false },
  [ContentTypes.VIDEO_URL]: { kind: 'generic', policy: 'always-mounted', forceMounted: false },
  [ContentTypes.INPUT_AUDIO]: { kind: 'generic', policy: 'always-mounted', forceMounted: false },
};

const knownSize = { width: 800, height: 600 };

describe('content-row classification over ContentTypes', () => {
  it('classifies every enum member', () => {
    for (const type of Object.values(ContentTypes)) {
      const expected = EXPECTED_BY_TYPE[type];
      const input =
        type === ContentTypes.IMAGE_FILE ? { type, imageDimensions: knownSize } : { type };
      expect({ ...classifyContentRow(input), type }).toEqual({ ...expected, type });
    }
  });

  it('covers exactly the enum members and no others', () => {
    expect(Object.keys(EXPECTED_BY_TYPE).sort()).toEqual(Object.values(ContentTypes).sort());
  });

  it('forces an in-flight source mounted instead of windowing it', () => {
    expect(classifyContentRow({ type: ContentTypes.THINK, streaming: true })).toEqual({
      kind: 'reasoning',
      policy: 'windowed',
      forceMounted: true,
    });
    expect(classifyContentRow({ type: ContentTypes.SUMMARY, streaming: true }).forceMounted).toBe(
      true,
    );
    expect(classifyContentRow({ type: ContentTypes.ERROR, streaming: true }).forceMounted).toBe(
      true,
    );
  });

  it('leaves a source that can never be windowed unmounted-proof rather than force-mounted', () => {
    const text = classifyContentRow({ type: ContentTypes.TEXT, streaming: true });
    expect(text).toEqual({ kind: 'markdown', policy: 'always-mounted', forceMounted: false });
  });

  it('treats a type this build does not know as always mounted', () => {
    expect(classifyContentRow({ type: 'mcp_tool_result' })).toEqual({
      kind: 'generic',
      policy: 'always-mounted',
      forceMounted: false,
    });
    expect(classifyContentRow({ type: 'mcp_tool_result', streaming: true }).forceMounted).toBe(
      false,
    );
  });
});

describe('known-size image classification', () => {
  const image = (imageDimensions: Parameters<typeof classifyContentRow>[0]['imageDimensions']) =>
    classifyContentRow({ type: ContentTypes.IMAGE_FILE, imageDimensions });

  it('accepts finite positive stored dimensions', () => {
    expect(image(knownSize).policy).toBe('unstable-until-settled');
  });

  it('refuses an image without stored dimensions', () => {
    expect(image(undefined).policy).toBe('always-mounted');
    expect(image(null).policy).toBe('always-mounted');
    expect(image({}).policy).toBe('always-mounted');
    expect(image({ width: 800 }).policy).toBe('always-mounted');
    expect(image({ height: 600 }).policy).toBe('always-mounted');
  });

  it('refuses zero, negative, and non-finite dimensions', () => {
    for (const bad of [
      { width: 0, height: 600 },
      { width: 800, height: 0 },
      { width: -800, height: 600 },
      { width: 800, height: Number.NaN },
      { width: Number.POSITIVE_INFINITY, height: 600 },
    ]) {
      expect(image(bad).policy).toBe('always-mounted');
    }
  });

  it('keeps the image kind for an unusable image, so the call site cannot re-derive it', () => {
    expect(image(undefined).kind).toBe('image');
  });
});

describe('windowable kind allow-list', () => {
  it('allows exactly the four Stage 3 kinds', () => {
    expect([...windowableContentRowKinds()].sort()).toEqual(
      ['generic', 'image', 'reasoning', 'summary'].sort(),
    );
  });

  it('leaves markdown, tools, parallel, subagent, and artifact kinds always mounted', () => {
    const windowable = windowableContentRowKinds();
    for (const kind of ['markdown', 'tool-group', 'parallel-section', 'subagent', 'artifact']) {
      expect(windowable.has(kind as ContentRowKind)).toBe(false);
    }
  });

  it('never classifies a kind outside the allow-list as windowable', () => {
    const windowable = windowableContentRowKinds();
    for (const type of Object.values(ContentTypes)) {
      for (const streaming of [false, true]) {
        for (const imageDimensions of [knownSize, undefined]) {
          const classification = classifyContentRow({ type, streaming, imageDimensions });
          if (classification.policy !== 'always-mounted') {
            expect(windowable.has(classification.kind)).toBe(true);
          }
        }
      }
    }
  });
});

describe('large-row threshold', () => {
  it('is 1200 px', () => {
    expect(LARGE_ROW_HEIGHT_PX).toBe(1200);
  });

  it('demotes only a height that exceeds the threshold', () => {
    expect(isOversizedRowHeight(0)).toBe(false);
    expect(isOversizedRowHeight(LARGE_ROW_HEIGHT_PX - 0.1)).toBe(false);
    expect(isOversizedRowHeight(LARGE_ROW_HEIGHT_PX)).toBe(false);
    expect(isOversizedRowHeight(LARGE_ROW_HEIGHT_PX + 0.1)).toBe(true);
    expect(isOversizedRowHeight(5000)).toBe(true);
  });
});

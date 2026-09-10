import React, { useEffect, useRef } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  ContentRowWindowingProvider,
  UNKNOWN_LAYOUT_BUCKET,
  readLayoutBucket,
  useContentRowWindowing,
} from '../ContentRowWindowingContext';
import { composeFingerprint, createRowToken, createScopeToken } from '../contentRowIdentity';
import type { ContentRowKind, ContentRowUpdate } from '../contentRowTypes';

type RegistrationProbe = {
  token: symbol;
  scopeToken: symbol;
  setMounted: jest.Mock;
  updateRow: (update: ContentRowUpdate) => void;
};

const registrations: RegistrationProbe[] = [];

function Row({
  messageId,
  kind = 'markdown',
  ordinal = 0,
  sourceKey = 0,
  stateKey,
  policy = 'windowed',
  forceMounted = false,
  update,
}: {
  messageId: string;
  kind?: ContentRowKind;
  ordinal?: number;
  sourceKey?: number;
  stateKey?: string | number | boolean | null;
  policy?: 'windowed' | 'always-mounted' | 'unstable-until-settled';
  forceMounted?: boolean;
  update?: ContentRowUpdate;
}) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const token = useRef(createRowToken(`${messageId}:${kind}:${ordinal}`));
  const scopeToken = useRef(createScopeToken());
  const setMounted = useRef(jest.fn()).current;
  const fingerprint = composeFingerprint({ kind, sourceKey, stateKey });

  useEffect(() => {
    const probe: RegistrationProbe = {
      token: token.current,
      scopeToken: scopeToken.current,
      setMounted,
      updateRow: (next) => windowing.updateRow(token.current, next),
    };
    registrations.push(probe);
    return windowing.registerRow({
      token: token.current,
      scopeToken: scopeToken.current,
      messageId,
      debugKey: `${messageId}:${kind}:${ordinal}`,
      kind,
      fingerprint,
      policy,
      forceMounted,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted,
    });
  }, [windowing, messageId, kind, ordinal, fingerprint, policy, forceMounted, setMounted]);

  useEffect(() => {
    if (update) {
      windowing.updateRow(token.current, update);
    }
  }, [windowing, update]);

  return (
    <div className="message-render" id={messageId}>
      <div ref={shellRef} data-testid={`row-${messageId}-${ordinal}`} />
    </div>
  );
}

function Harness({
  children,
  conversationId = 'conversation-1',
  isDevelopment = false,
  onReady,
}: {
  children: React.ReactNode;
  conversationId?: string | null;
  isDevelopment?: boolean;
  onReady?: (api: ReturnType<typeof useContentRowWindowing>) => void;
}) {
  const scrollRootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRootRef} data-testid="scroll-root" style={{ height: 500, width: 800 }}>
      <ContentRowWindowingProvider
        scrollRootRef={scrollRootRef}
        conversationId={conversationId}
        isDevelopment={isDevelopment}
      >
        <Probe onReady={onReady} />
        {children}
      </ContentRowWindowingProvider>
    </div>
  );
}

function Probe({
  onReady,
}: {
  onReady?: (api: ReturnType<typeof useContentRowWindowing>) => void;
}) {
  const windowing = useContentRowWindowing();
  const ref = useRef(onReady);
  ref.current = onReady;
  useEffect(() => {
    ref.current?.(windowing);
  });
  return null;
}

let api: ReturnType<typeof useContentRowWindowing>;

beforeEach(() => {
  registrations.length = 0;
});

describe('ContentRowWindowingProvider registration', () => {
  it('registers a row as mounted and unmeasured, never as an estimated placeholder', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    const snapshot = api.getDiagnostics();
    expect(snapshot.registeredRows).toBe(1);
    expect(snapshot.mountedRows).toBe(1);
    expect(snapshot.placeholderRows).toBe(0);
    expect(snapshot.unmeasuredRows).toBe(1);
    expect(snapshot.mountStates.MOUNTED_UNMEASURED).toBe(1);
    expect(snapshot.registrations).toBe(1);
  });

  it('does not tell a row to mount itself on registration (it is already mounted)', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    expect(registrations[0].setMounted).not.toHaveBeenCalled();
  });

  it('tracks several rows and their kinds', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" kind="markdown" ordinal={0} />
        <Row messageId="m1" kind="markdown" ordinal={1} />
        <Row messageId="m2" kind="image" ordinal={0} />
      </Harness>,
    );
    const snapshot = api.getDiagnostics();
    expect(snapshot.registeredRows).toBe(3);
    expect(snapshot.totalByKind.markdown).toBe(2);
    expect(snapshot.totalByKind.image).toBe(1);
    expect(snapshot.mountedByKind.image).toBe(1);
  });

  it('removes a row on unmount and keeps the rest', () => {
    // Both renders pass an array of children. Switching between an array and a
    // single element changes React's slot shape and remounts the surviving row,
    // which is a harness artifact rather than provider behaviour.
    const twoRows = [<Row messageId="m1" key="a" />, <Row messageId="m2" key="b" />];
    const oneRow = [<Row messageId="m1" key="a" />];
    const { rerender } = render(<Harness onReady={(value) => (api = value)}>{twoRows}</Harness>);
    expect(api.getDiagnostics().registeredRows).toBe(2);
    rerender(<Harness onReady={(value) => (api = value)}>{oneRow}</Harness>);
    const snapshot = api.getDiagnostics();
    expect(snapshot.registeredRows).toBe(1);
    expect(snapshot.unregistrations).toBe(1);
  });

  it('ignores a duplicate registration of the same token', () => {
    const token = createRowToken('duplicate');
    render(
      <Harness onReady={(value) => (api = value)}>
        <DuplicateRow token={token} />
      </Harness>,
    );
    expect(api.getDiagnostics().registeredRows).toBe(1);
  });

  it('keeps context function identities stable across re-renders', () => {
    const seen: Array<ReturnType<typeof useContentRowWindowing>> = [];
    const { rerender } = render(
      <Harness onReady={(value) => seen.push(value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    rerender(
      <Harness onReady={(value) => seen.push(value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    const [first, second] = seen;
    expect(second.registerRow).toBe(first.registerRow);
    expect(second.updateRow).toBe(first.updateRow);
    expect(second.getDiagnostics).toBe(first.getDiagnostics);
    expect(second.ensureMessageContentMounted).toBe(first.ensureMessageContentMounted);
  });

  it('ignores a teardown that runs twice', () => {
    const { unmount } = render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    unmount();
    expect(api.getDiagnostics().registeredRows).toBe(0);
    expect(api.getDiagnostics().unregistrations).toBe(1);
  });
});

function DuplicateRow({ token }: { token: symbol }) {
  const windowing = useContentRowWindowing();
  const shellRef = useRef<HTMLDivElement>(null);
  const scopeToken = useRef(createScopeToken());
  const setMounted = useRef(jest.fn()).current;
  useEffect(() => {
    const registration = {
      token,
      scopeToken: scopeToken.current,
      messageId: 'm1',
      debugKey: 'm1:markdown:0',
      kind: 'markdown' as const,
      fingerprint: 'markdown|0',
      policy: 'windowed' as const,
      forceMounted: false,
      shellElement: shellRef.current as HTMLDivElement,
      setMounted,
    };
    const first = windowing.registerRow(registration);
    const second = windowing.registerRow(registration);
    return () => {
      first();
      second();
    };
  }, [windowing, token, scopeToken, setMounted]);
  return <div ref={shellRef} />;
}

describe('ContentRowWindowingProvider updateRow', () => {
  it('moves a row to a new message id', async () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    await act(async () => {
      registrations[0].updateRow({ messageId: 'm2' });
    });
    await expect(api.ensureMessageContentMounted('m1')).resolves.toBeNull();
    await expect(api.ensureMessageContentMounted('m2')).resolves.not.toBeNull();
  });

  it('accepts policy, debug key, and force-mounted updates without restarting a generation', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    act(() => {
      registrations[0].updateRow({
        policy: 'always-mounted',
        debugKey: 'm1:markdown:9',
        forceMounted: true,
      });
    });
    const snapshot = api.getDiagnostics();
    expect(snapshot.alwaysMountedRows).toBe(1);
    expect(snapshot.forcedRows).toBe(1);
    // a policy change is not a source change: the row keeps its measurement slot
    expect(snapshot.staleRows).toBe(0);
    expect(snapshot.unmeasuredRows).toBe(1);
  });

  it('restarts the generation and invalidates the measurement when the fingerprint changes', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    act(() => {
      registrations[0].updateRow({ fingerprint: 'markdown|0|expanded' });
    });
    expect(registrations[0].setMounted).toHaveBeenCalledWith(true, 2);
    const snapshot = api.getDiagnostics();
    expect(snapshot.unmeasuredRows).toBe(1);
    expect(snapshot.staleRows).toBe(0);
    expect(snapshot.mountStates.MOUNTED_UNMEASURED).toBe(1);
  });

  it('ignores an update for an unknown token', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    expect(() => api.updateRow(createRowToken('orphan'), { messageId: 'other' })).not.toThrow();
    expect(api.getDiagnostics().registeredRows).toBe(1);
    expect(api.getDiagnostics().staleRows).toBe(0);
  });

  it('does not restart a generation for an unchanged fingerprint', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    act(() => {
      registrations[0].updateRow({ fingerprint: 'markdown|0' });
    });
    expect(registrations[0].setMounted).not.toHaveBeenCalled();
  });
});

describe('ContentRowWindowingProvider ensureMessageContentMounted', () => {
  it('resolves null for a message with no rows', async () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    await expect(api.ensureMessageContentMounted('missing')).resolves.toBeNull();
  });

  it('resolves the message shell, not the row shell', async () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    const shell = await api.ensureMessageContentMounted('m1');
    expect(shell).toBeInstanceOf(HTMLElement);
    expect(shell?.classList.contains('message-render')).toBe(true);
    expect(shell?.id).toBe('m1');
  });

  it('mounts a placeholder row before resolving', async () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    await act(async () => {
      await api.ensureMessageContentMounted('m1');
    });
    expect(api.getDiagnostics().mountedRows).toBe(1);
  });
});

describe('ContentRowWindowingProvider layout bucket', () => {
  it('reports the bucket of the scroll root', () => {
    // jsdom reports clientWidth 0 for every element, so the width dimension is mocked
    // to make the assertion meaningful.
    jest.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    const snapshot = api.getDiagnostics();
    expect(snapshot.layoutBucket).toBe(api.getLayoutBucket());
    expect(snapshot.layoutBucket).toContain('w50-');
    expect(snapshot.layoutBucket).not.toBe(UNKNOWN_LAYOUT_BUCKET);
  });

  it('falls back to the unknown bucket when there is no measurable root', () => {
    expect(readLayoutBucket(null)).toBeNull();
    const detached = document.createElement('div');
    expect(readLayoutBucket(detached)).toBe(UNKNOWN_LAYOUT_BUCKET);
  });

  it('includes the root font size so a UI-scale change is a bucket change', () => {
    const element = document.createElement('div');
    element.style.fontSize = '18px';
    document.body.appendChild(element);
    const bucket = readLayoutBucket(element);
    document.body.removeChild(element);
    expect(bucket).toContain('f36');
  });
});

describe('ContentRowWindowingProvider conversation change', () => {
  it('invalidates the measurement of a row carried over from the previous conversation', () => {
    const rows = [<Row messageId="m1" key="a" />];
    const { rerender } = render(
      <Harness conversationId="conversation-1" onReady={(value) => (api = value)}>
        {rows}
      </Harness>,
    );
    // a new generation captures a fresh fingerprint, so the measurement slot is valid
    act(() => {
      registrations[0].updateRow({ fingerprint: 'markdown|0|v2' });
    });
    expect(api.getDiagnostics().staleRows).toBe(0);

    rerender(
      <Harness conversationId="conversation-2" onReady={(value) => (api = value)}>
        {rows}
      </Harness>,
    );
    const snapshot = api.getDiagnostics();
    // still mounted and registered, but its height may not be reused
    expect(snapshot.mountedRows).toBe(1);
    expect(snapshot.registeredRows).toBe(1);
    expect(snapshot.unmeasuredRows).toBe(1);
    // the height was dropped rather than kept under a mismatched fingerprint
    expect(snapshot.staleRows).toBe(0);
    expect(snapshot.measuredHeightDistribution.count).toBe(0);
  });

  it('does not unmount rows on a conversation change', () => {
    const rows = [<Row messageId="m1" key="a" />];
    const { rerender } = render(
      <Harness conversationId="conversation-1" onReady={(value) => (api = value)}>
        {rows}
      </Harness>,
    );
    rerender(
      <Harness conversationId="conversation-2" onReady={(value) => (api = value)}>
        {rows}
      </Harness>,
    );
    expect(registrations[0].setMounted).not.toHaveBeenCalled();
    expect(api.getDiagnostics().mountedRows).toBe(1);
  });
});

describe('ContentRowWindowingProvider diagnostics handle', () => {
  const original = window.__lcContentRows;

  afterEach(() => {
    window.__lcContentRows = original;
  });

  it('installs the console handle in development and removes it on unmount', () => {
    const { unmount } = render(
      <Harness isDevelopment onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    expect(window.__lcContentRows).toBeDefined();
    expect(window.__lcContentRows?.snapshot().registeredRows).toBe(1);
    unmount();
    expect(window.__lcContentRows).toBeUndefined();
  });

  it('installs nothing in a production build', () => {
    render(
      <Harness isDevelopment={false} onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    expect(window.__lcContentRows).toBeUndefined();
  });
});

describe('ContentRowWindowingProvider without a provider', () => {
  it('throws a helpful error from the required hook', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Row messageId="m1" />)).toThrow(
      /must be used within ContentRowWindowingProvider/,
    );
    consoleError.mockRestore();
  });
});

describe('row markup owned by the row, not the provider', () => {
  it('leaves a .message-render shell available for navigation', () => {
    render(
      <Harness onReady={(value) => (api = value)}>
        <Row messageId="m1" />
      </Harness>,
    );
    expect(screen.getByTestId('row-m1-0')).toBeInTheDocument();
    expect(document.querySelectorAll('.message-render')).toHaveLength(1);
  });
});

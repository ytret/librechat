import React, { useCallback, useEffect, useRef, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MessageWindowingProvider, useMessageWindowing } from '../MessageWindowingContext';
import { estimateMessageHeight } from '../messageHeightEstimate';
import type { TMessage } from 'librechat-data-provider';

const message = (id: string) => ({ messageId: id, conversationId: 'conversation', text: id }) as TMessage;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this);
  }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  constructor(public callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
}

const originalIO = global.IntersectionObserver;
const originalRO = global.ResizeObserver;
const originalRAF = global.requestAnimationFrame;

function RegisteredRow({ id, forceMounted = false }: { id: string; forceMounted?: boolean }) {
  const windowing = useMessageWindowing();
  const element = useRef<HTMLDivElement>(null);
  const token = useRef(Symbol(id));
  const [mounted, setMounted] = useState(forceMounted);
  useEffect(
    () =>
      windowing.registerRow({
        token: token.current,
        id,
        message: message(id),
        element: element.current,
        forceMounted,
        setMounted,
      }),
    [forceMounted, id, windowing],
  );
  return (
    <div ref={element} data-testid={id} data-message-virtual-row="true" data-mounted={mounted ? 'true' : 'false'}>
      {mounted ? <span data-testid={`${id}-content`}>expensive content</span> : null}
    </div>
  );
}

function Harness({ children }: { children: React.ReactNode }) {
  const scrollableRef = useRef<HTMLDivElement>(null);
  return (
    <MessageWindowingProvider scrollableRef={scrollableRef} conversationId="conversation">
      <div ref={scrollableRef} className="scroll-root">{children}</div>
    </MessageWindowingProvider>
  );
}

function MeasuredRow({ id = 'measured', forceMounted = true }: { id?: string; forceMounted?: boolean }) {
  const windowing = useMessageWindowing();
  const token = useRef(Symbol(id));
  const element = useRef<HTMLDivElement>(null);
  const [mounted, setMountedState] = useState(forceMounted);
  const height = useRef(estimateMessageHeight(message(id)));
  const setMounted = useCallback((value: boolean, measuredHeight?: number) => {
    if (!value && typeof measuredHeight === 'number' && measuredHeight > 0) {
      height.current = measuredHeight;
    }
    setMountedState(value);
  }, []);
  useEffect(
    () =>
      windowing.registerRow({
        token: token.current,
        id,
        message: message(id),
        element: element.current,
        forceMounted,
        setMounted,
      }),
    [forceMounted, id, windowing, setMounted],
  );
  return (
    <div
      ref={element}
      data-testid={id}
      data-message-virtual-row="true"
      data-mounted={mounted ? 'true' : 'false'}
      style={mounted ? undefined : { height: `${height.current}px` }}
    >
      {mounted ? <span data-testid={`${id}-content`}>expensive content</span> : null}
    </div>
  );
}

const ROOT_RECT = { top: 0, bottom: 500, height: 500, left: 0, right: 500, width: 500 } as DOMRect;

function mockRects(rowRects: Record<string, DOMRect>, rootRect: DOMRect = ROOT_RECT) {
  return jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('scroll-root')) return rootRect;
    const testid = this.getAttribute('data-testid');
    if (testid && rowRects[testid]) return rowRects[testid];
    return ROOT_RECT;
  });
}

function defineScroll(root: HTMLElement, opts: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }) {
  Object.defineProperty(root, 'scrollHeight', { value: opts.scrollHeight ?? 2000, configurable: true });
  Object.defineProperty(root, 'clientHeight', { value: opts.clientHeight ?? 500, configurable: true });
  Object.defineProperty(root, 'scrollTop', { value: opts.scrollTop ?? 0, writable: true, configurable: true });
}

function resizeEntry(target: Element, height: number) {
  return {
    target,
    contentRect: { height },
    borderBoxSize: [{ blockSize: height }],
  } as unknown as ResizeObserverEntry;
}

describe('MessageWindowingProvider', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    MockResizeObserver.instances = [];
    global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return undefined;
    }) as unknown as typeof requestAnimationFrame;
  });

  afterEach(() => {
    global.IntersectionObserver = originalIO;
    global.ResizeObserver = originalRO;
    global.requestAnimationFrame = originalRAF;
  });

  it('keeps a shell and mounts expensive content when forced', () => {
    render(
      <Harness>
        <RegisteredRow id="message-1" forceMounted />
      </Harness>,
    );
    expect(screen.getByTestId('message-1')).toHaveAttribute('data-mounted', 'true');
    expect(screen.getByTestId('message-1-content')).toBeInTheDocument();
    expect(MockIntersectionObserver.instances).toHaveLength(1);
    expect(MockResizeObserver.instances).toHaveLength(1);
  });

  it('disconnects shared observers on unmount', () => {
    const view = render(
      <Harness>
        <RegisteredRow id="message-1" />
        <RegisteredRow id="message-2" />
      </Harness>,
    );
    const io = MockIntersectionObserver.instances[0];
    const ro = MockResizeObserver.instances[0];
    view.unmount();
    expect(io.disconnect).toHaveBeenCalledTimes(1);
    expect(ro.disconnect).toHaveBeenCalledTimes(1);
  });

  it('moves row lookup when a message ID changes', async () => {
    function RenamedRow() {
      const windowing = useMessageWindowing();
      const token = useRef(Symbol('id-change'));
      const element = useRef<HTMLDivElement>(null);
      const [mounted, setMounted] = useState(false);
      useEffect(() => windowing.registerRow({ token: token.current, id: 'message-1', message: message('message-1'), element: element.current, forceMounted: false, setMounted }), [windowing]);
      return (
        <>
          <div ref={element} data-testid="renamed" data-mounted={mounted ? 'true' : 'false'} />
          <button onClick={() => windowing.updateRowId(token.current, 'message-1', 'server-1')}>rename</button>
          <button onClick={() => void windowing.ensureMessageMounted('server-1')}>find renamed</button>
        </>
      );
    }
    render(<Harness><RenamedRow /></Harness>);
    await act(async () => screen.getByRole('button', { name: 'rename' }).click());
    await act(async () => screen.getByRole('button', { name: 'find renamed' }).click());
    expect(screen.getByTestId('renamed')).toHaveAttribute('data-mounted', 'true');
  });

  it('materializes synchronously on browser find without preventing the native event', () => {
    render(
      <Harness>
        <RegisteredRow id="message-1" />
        <RegisteredRow id="message-2" />
      </Harness>,
    );
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.getByTestId('message-1-content')).toBeInTheDocument();
    expect(screen.getByTestId('message-2-content')).toBeInTheDocument();
  });

  it('materializes a requested navigation target and waits for the render turn', async () => {
    function Requester() {
      const { ensureMessageMounted } = useMessageWindowing();
      return <button onClick={() => void ensureMessageMounted('message-2')}>jump</button>;
    }
    render(
      <Harness>
        <RegisteredRow id="message-1" />
        <RegisteredRow id="message-2" />
        <Requester />
      </Harness>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'jump' }).click();
      await Promise.resolve();
    });
    expect(screen.getByTestId('message-2-content')).toBeInTheDocument();
  });

  it('materializes every registered row and restores optimization', async () => {
    function Materializer() {
      const { materializeAll } = useMessageWindowing();
      return <button onClick={() => void materializeAll('debug')}>materialize</button>;
    }
    render(
      <Harness>
        <RegisteredRow id="message-1" />
        <RegisteredRow id="message-2" />
        <Materializer />
      </Harness>,
    );
    await act(async () => {
      screen.getByRole('button', { name: 'materialize' }).click();
    });
    expect(screen.getByTestId('message-1-content')).toBeInTheDocument();
    expect(screen.getByTestId('message-2-content')).toBeInTheDocument();
  });

  it('restores the previous windowing policy when materialization cleanup runs', async () => {
    const rectSpy = mockRects({ message1: { top: 5000, bottom: 5100, height: 100 } as DOMRect });
    let cleanup: (() => void) | undefined;
    function Materializer() {
      const { materializeAll } = useMessageWindowing();
      return <button onClick={async () => { cleanup = await materializeAll('debug'); }}>materialize</button>;
    }
    render(
      <Harness>
        <RegisteredRow id="message1" />
        <Materializer />
      </Harness>,
    );
    await act(async () => screen.getByRole('button', { name: 'materialize' }).click());
    expect(screen.getByTestId('message1-content')).toBeInTheDocument();
    await act(async () => cleanup?.());
    await act(async () => {});
    expect(screen.getByTestId('message1')).toBeInTheDocument();
    rectSpy.mockRestore();
  });

  it('invalidates a row estimate on a message content layout event', () => {
    render(
      <Harness>
        <RegisteredRow id="message-1" />
      </Harness>,
    );
    const row = screen.getByTestId('message-1');
    act(() => row.dispatchEvent(new CustomEvent('librechat:message-content-layout-change', { bubbles: true })));
    expect(row).toBeInTheDocument();
  });

  it('pins the shell containing a non-collapsed selection', () => {
    const rectSpy = mockRects({ message1: { top: 5000, bottom: 5100, height: 100 } as DOMRect });
    render(
      <Harness>
        <RegisteredRow id="message1" />
      </Harness>,
    );
    const row = screen.getByTestId('message1');
    const text = document.createTextNode('selected text');
    row.appendChild(text);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(text);
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => document.dispatchEvent(new Event('selectionchange')));
    expect(row).toHaveAttribute('data-mounted', 'true');
    selection.removeAllRanges();
    act(() => document.dispatchEvent(new Event('selectionchange')));
    rectSpy.mockRestore();
  });

  describe('scroll-anchor correction', () => {
    const ABOVE = { top: -400, bottom: -300, height: 100 } as DOMRect;
    const INSIDE = { top: 100, bottom: 200, height: 100 } as DOMRect;
    const BELOW = { top: 600, bottom: 700, height: 100 } as DOMRect;

    it('applies a positive first-measurement delta above the viewport', () => {
      const rectSpy = mockRects({ measured: ABOVE });
      render(
        <Harness>
          <MeasuredRow id="measured" />
        </Harness>,
      );
      const root = document.querySelector('.scroll-root') as HTMLElement;
      defineScroll(root, { scrollTop: 100 });
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(screen.getByTestId('measured'), 600)], resize as unknown as ResizeObserver));
      // estimate 420 -> measured 600 = +180
      expect(root.scrollTop).toBe(280);
      rectSpy.mockRestore();
    });

    it('applies a negative first-measurement delta above the viewport', () => {
      const rectSpy = mockRects({ measured: ABOVE });
      render(
        <Harness>
          <MeasuredRow id="measured" />
        </Harness>,
      );
      const root = document.querySelector('.scroll-root') as HTMLElement;
      defineScroll(root, { scrollTop: 500 });
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(screen.getByTestId('measured'), 300)], resize as unknown as ResizeObserver));
      // estimate 420 -> measured 300 = -120
      expect(root.scrollTop).toBe(380);
      rectSpy.mockRestore();
    });

    it('does not apply a whole-row correction inside the viewport', () => {
      const rectSpy = mockRects({ measured: INSIDE });
      render(
        <Harness>
          <MeasuredRow id="measured" />
        </Harness>,
      );
      const root = document.querySelector('.scroll-root') as HTMLElement;
      defineScroll(root, { scrollTop: 100 });
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(screen.getByTestId('measured'), 600)], resize as unknown as ResizeObserver));
      expect(root.scrollTop).toBe(100);
      rectSpy.mockRestore();
    });

    it('does not apply a whole-row correction below the viewport', () => {
      const rectSpy = mockRects({ measured: BELOW });
      render(
        <Harness>
          <MeasuredRow id="measured" />
        </Harness>,
      );
      const root = document.querySelector('.scroll-root') as HTMLElement;
      defineScroll(root, { scrollTop: 100 });
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(screen.getByTestId('measured'), 600)], resize as unknown as ResizeObserver));
      expect(root.scrollTop).toBe(100);
      rectSpy.mockRestore();
    });

    it('does not correct when the user is bottom-pinned', () => {
      const rectSpy = mockRects({ measured: ABOVE });
      render(
        <Harness>
          <MeasuredRow id="measured" />
        </Harness>,
      );
      const root = document.querySelector('.scroll-root') as HTMLElement;
      defineScroll(root, { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 });
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(screen.getByTestId('measured'), 600)], resize as unknown as ResizeObserver));
      expect(root.scrollTop).toBe(1500);
      rectSpy.mockRestore();
    });

    it('sums multiple row deltas into exactly one scrollTop write', () => {
      const rafQueue: FrameRequestCallback[] = [];
      global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        rafQueue.push(callback);
        return rafQueue.length;
      }) as typeof requestAnimationFrame;
      try {
        const rectSpy = mockRects({ row1: ABOVE, row2: ABOVE });
        render(
          <Harness>
            <MeasuredRow id="row1" />
            <MeasuredRow id="row2" />
          </Harness>,
        );
        const root = document.querySelector('.scroll-root') as HTMLElement;
        let scrollTop = 100;
        const writes: number[] = [];
        Object.defineProperty(root, 'scrollHeight', { value: 2000, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 500, configurable: true });
        Object.defineProperty(root, 'scrollTop', {
          get: () => scrollTop,
          set: (value: number) => {
            scrollTop = value;
            writes.push(value);
          },
          configurable: true,
        });
        const resize = MockResizeObserver.instances[0];
        act(() => {
          resize.callback(
            [
              resizeEntry(screen.getByTestId('row1'), 500),
              resizeEntry(screen.getByTestId('row2'), 700),
            ],
            resize as unknown as ResizeObserver,
          );
        });
        // Flush every queued animation frame explicitly. The two deltas
        // (+80 and +280) must be combined into a single scrollTop write.
        act(() => {
          while (rafQueue.length) {
            const cb = rafQueue.shift()!;
            cb(0);
          }
        });
        expect(writes).toHaveLength(1);
        expect(writes[0]).toBe(460);
        rectSpy.mockRestore();
      } finally {
        global.requestAnimationFrame = originalRAF;
      }
    });

    it('uses the latest measured height when a row becomes a placeholder', () => {
      let rowRect: DOMRect = INSIDE;
      const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('scroll-root')) return ROOT_RECT;
        return rowRect;
      });
      render(
        <Harness>
          <MeasuredRow id="measured" forceMounted={false} />
        </Harness>,
      );
      const shell = screen.getByTestId('measured');
      // Initially inside the viewport, so the provider mounts the row.
      expect(shell).toHaveAttribute('data-mounted', 'true');
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(shell, 600)], resize as unknown as ResizeObserver));
      // Move it far below and re-evaluate so it unmounts into a placeholder.
      rowRect = { top: 5000, bottom: 5100, height: 100 } as DOMRect;
      act(() => fireEvent.scroll(document.querySelector('.scroll-root') as HTMLElement));
      expect(shell).toHaveAttribute('data-mounted', 'false');
      expect(shell.style.height).toBe('600px');
      rectSpy.mockRestore();
    });

    it('preserves the measured height across an SSE ID replacement', () => {
      function RenameableRow() {
        const windowing = useMessageWindowing();
        const token = useRef(Symbol('renameable'));
        const element = useRef<HTMLDivElement>(null);
        const [mounted, setMountedState] = useState(false);
        const height = useRef(estimateMessageHeight(message('client-id')));
        const setMounted = useCallback((value: boolean, measuredHeight?: number) => {
          if (!value && typeof measuredHeight === 'number' && measuredHeight > 0) height.current = measuredHeight;
          setMountedState(value);
        }, []);
        useEffect(() => windowing.registerRow({ token: token.current, id: 'client-id', message: message('client-id'), element: element.current, forceMounted: false, setMounted }), [windowing, setMounted]);
        return (
          <>
            <div ref={element} data-testid="renameable" data-mounted={mounted ? 'true' : 'false'} style={mounted ? undefined : { height: `${height.current}px` }} />
            <button onClick={() => windowing.updateRowId(token.current, 'client-id', 'server-id')}>rename</button>
          </>
        );
      }
      let rowRect: DOMRect = INSIDE;
      const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('scroll-root')) return ROOT_RECT;
        return rowRect;
      });
      render(
        <Harness>
          <RenameableRow />
        </Harness>,
      );
      const shell = screen.getByTestId('renameable');
      const resize = MockResizeObserver.instances[0];
      act(() => resize.callback([resizeEntry(shell, 600)], resize as unknown as ResizeObserver));
      act(() => screen.getByRole('button', { name: 'rename' }).click());
      // The measurement lives on the positional token, not the public ID.
      rowRect = { top: 5000, bottom: 5100, height: 100 } as DOMRect;
      act(() => fireEvent.scroll(document.querySelector('.scroll-root') as HTMLElement));
      expect(shell).toHaveAttribute('data-mounted', 'false');
      expect(shell.style.height).toBe('600px');
      rectSpy.mockRestore();
    });
  });
});

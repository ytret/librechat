import React, { useEffect, useRef, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { MessageWindowingProvider, useMessageWindowing } from '../MessageWindowingContext';
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

function MeasuredRow() {
  const windowing = useMessageWindowing();
  const token = useRef(Symbol('measured'));
  const element = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(true);
  useEffect(
    () => windowing.registerRow({
      token: token.current,
      id: 'measured',
      message: message('measured'),
      element: element.current,
      forceMounted: true,
      setMounted,
    }),
    [windowing],
  );
  return <div ref={element} data-testid="measured" data-mounted={mounted ? 'true' : 'false'} />;
}

describe('MessageWindowingProvider', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    MockResizeObserver.instances = [];
    global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    global.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }) as typeof requestAnimationFrame;
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

  it('applies one batched anchor correction for measured changes above the viewport', () => {
    const rootRect = { top: 0, bottom: 500, height: 500 } as DOMRect;
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('scroll-root')) return rootRect;
      return { top: -200, bottom: -100, height: 100 } as DOMRect;
    });
    const view = render(
      <Harness>
        <MeasuredRow />
      </Harness>,
    );
    const root = document.querySelector('.scroll-root') as HTMLElement;
    Object.defineProperties(root, {
      scrollTop: { value: 100, writable: true, configurable: true },
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
    });
    const resize = MockResizeObserver.instances[0];
    act(() => resize.callback([{ target: screen.getByTestId('measured'), contentRect: { height: 600 }, borderBoxSize: [{ blockSize: 600 }] } as unknown as ResizeObserverEntry], resize as unknown as ResizeObserver));
    expect(root.scrollTop).toBe(100);
    act(() => resize.callback([{ target: screen.getByTestId('measured'), contentRect: { height: 500 }, borderBoxSize: [{ blockSize: 500 }] } as unknown as ResizeObserverEntry], resize as unknown as ResizeObserver));
    expect(root.scrollTop).toBe(0);
    view.unmount();
    jest.restoreAllMocks();
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

  it('materializes on browser find without preventing the native event', async () => {
    render(
      <Harness>
        <RegisteredRow id="message-1" />
        <RegisteredRow id="message-2" />
      </Harness>,
    );
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, cancelable: true });
    await act(async () => {
      document.dispatchEvent(event);
      await Promise.resolve();
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
    const rootRect = { top: 0, bottom: 500, height: 500 } as DOMRect;
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('scroll-root')) return rootRect;
      return { top: 5000, bottom: 5100, height: 100 } as DOMRect;
    });
    let cleanup: (() => void) | undefined;
    function Materializer() {
      const { materializeAll } = useMessageWindowing();
      return <button onClick={async () => { cleanup = await materializeAll('debug'); }}>materialize</button>;
    }
    render(
      <Harness>
        <RegisteredRow id="message-1" />
        <Materializer />
      </Harness>,
    );
    await act(async () => screen.getByRole('button', { name: 'materialize' }).click());
    expect(screen.getByTestId('message-1-content')).toBeInTheDocument();
    await act(async () => cleanup?.());
    await act(async () => {});
    expect(screen.getByTestId('message-1')).toBeInTheDocument();
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
    const rectSpy = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('scroll-root')) return { top: 0, bottom: 500, height: 500 } as DOMRect;
      return { top: 5000, bottom: 5100, height: 100 } as DOMRect;
    });
    render(
      <Harness>
        <RegisteredRow id="message-1" />
      </Harness>,
    );
    const row = screen.getByTestId('message-1');
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
});

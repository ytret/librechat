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
    <div ref={element} data-testid={id} data-mounted={mounted ? 'true' : 'false'}>
      {mounted ? <span data-testid={`${id}-content`}>expensive content</span> : null}
    </div>
  );
}

function Harness({ children }: { children: React.ReactNode }) {
  const scrollableRef = useRef<HTMLDivElement>(null);
  return (
    <MessageWindowingProvider scrollableRef={scrollableRef} conversationId="conversation">
      <div ref={scrollableRef}>{children}</div>
    </MessageWindowingProvider>
  );
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
});

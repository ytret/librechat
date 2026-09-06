import React, { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ScreenshotProvider, useScreenshot } from '../ScreenshotContext';

const mockToCanvas = jest.fn();
jest.mock('html-to-image', () => ({
  toCanvas: (...args: unknown[]) => mockToCanvas(...args),
}));

jest.mock('@librechat/client', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    ThemeContext: ReactActual.createContext({
      theme: 'light',
      setTheme: () => undefined,
      setThemeRGB: () => undefined,
      setThemeName: () => undefined,
      resetTheme: () => undefined,
    }),
    isDark: () => false,
  };
});

type Materializer = () => Promise<() => void>;

function Registrar({ materializer }: { materializer: Materializer }) {
  const { registerMaterializer } = useScreenshot();
  useEffect(() => registerMaterializer?.(materializer), [registerMaterializer, materializer]);
  return null;
}

function Capture({ onResult }: { onResult: (value: unknown) => void }) {
  const { screenshotTargetRef, captureScreenshot } = useScreenshot();
  return (
    <div>
      <div ref={screenshotTargetRef}>screenshot target</div>
      <button onClick={() => captureScreenshot().then(onResult, onResult)}>capture</button>
    </div>
  );
}

function renderHarness(materializer: Materializer, onResult: (value: unknown) => void) {
  return render(
    <ScreenshotProvider>
      <Registrar materializer={materializer} />
      <Capture onResult={onResult} />
    </ScreenshotProvider>,
  );
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ScreenshotContext', () => {
  beforeEach(() => {
    mockToCanvas.mockReset();
  });

  it('materializes all rows before capture and restores them after success', async () => {
    const order: string[] = [];
    const materializer = jest.fn(async () => {
      order.push('materialize');
      return () => {
        order.push('cleanup');
      };
    });

    const canvas = { width: 100, height: 100 };
    mockToCanvas.mockResolvedValue(canvas);
    const getContext = jest.fn(() => ({
      fillStyle: '',
      fillRect: jest.fn(),
      drawImage: jest.fn(),
    }));
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(getContext as never);
    jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,abc');

    const { promise, resolve } = deferred();
    renderHarness(materializer, resolve);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'capture' }));
      await promise;
    });

    expect(materializer).toHaveBeenCalledTimes(1);
    expect(mockToCanvas).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['materialize', 'cleanup']);

    (HTMLCanvasElement.prototype.getContext as jest.Mock).mockRestore();
    (HTMLCanvasElement.prototype.toDataURL as jest.Mock).mockRestore();
  });

  it('restores windowing when toCanvas rejects', async () => {
    const order: string[] = [];
    const materializer = jest.fn(async () => {
      order.push('materialize');
      return () => {
        order.push('cleanup');
      };
    });
    mockToCanvas.mockRejectedValue(new Error('capture failed'));

    const { promise, resolve } = deferred();
    renderHarness(materializer, resolve);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'capture' }));
      await promise;
    });

    expect(materializer).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['materialize', 'cleanup']);
  });

  it('invokes only the current provider materializer across nested providers', async () => {
    const outerOrder: string[] = [];
    const innerOrder: string[] = [];
    const outerMaterializer = jest.fn(async () => {
      outerOrder.push('materialize');
      return () => {
        outerOrder.push('cleanup');
      };
    });
    const innerMaterializer = jest.fn(async () => {
      innerOrder.push('materialize');
      return () => {
        innerOrder.push('cleanup');
      };
    });

    const canvas = { width: 10, height: 10 };
    mockToCanvas.mockResolvedValue(canvas);
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ fillStyle: '', fillRect: jest.fn(), drawImage: jest.fn() }) as never,
    );
    jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,inner');

    function Inner() {
      const { screenshotTargetRef, captureScreenshot } = useScreenshot();
      return (
        <div>
          <div ref={screenshotTargetRef}>inner target</div>
          <button
            onClick={() =>
              void captureScreenshot().then(() => {
                innerResolve(undefined);
              })
            }
          >
            inner capture
          </button>
        </div>
      );
    }

    let innerResolve!: (value: unknown) => void;
    const innerDone = new Promise<unknown>((r) => {
      innerResolve = r;
    });

    render(
      <ScreenshotProvider>
        <Registrar materializer={outerMaterializer} />
        <ScreenshotProvider>
          <Registrar materializer={innerMaterializer} />
          <Inner />
        </ScreenshotProvider>
      </ScreenshotProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'inner capture' }));
      await innerDone;
    });

    expect(innerMaterializer).toHaveBeenCalledTimes(1);
    expect(outerMaterializer).not.toHaveBeenCalled();
    expect(innerOrder).toEqual(['materialize', 'cleanup']);
    expect(outerOrder).toEqual([]);

    (HTMLCanvasElement.prototype.getContext as jest.Mock).mockRestore();
    (HTMLCanvasElement.prototype.toDataURL as jest.Mock).mockRestore();
  });

  it('removes a materializer registration when the registering component unmounts', async () => {
    const order: string[] = [];
    const materializer = jest.fn(async () => {
      order.push('materialize');
      return () => {
        order.push('cleanup');
      };
    });
    const canvas = { width: 10, height: 10 };
    mockToCanvas.mockResolvedValue(canvas);
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ({ fillStyle: '', fillRect: jest.fn(), drawImage: jest.fn() }) as never,
    );
    jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,x');

    const { promise, resolve } = deferred();
    function App({ showRegistrar }: { showRegistrar: boolean }) {
      return (
        <ScreenshotProvider>
          {showRegistrar ? <Registrar materializer={materializer} /> : null}
          <Capture onResult={resolve} />
        </ScreenshotProvider>
      );
    }

    const view = render(<App showRegistrar />);
    view.rerender(<App showRegistrar={false} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'capture' }));
      await promise;
    });

    expect(materializer).not.toHaveBeenCalled();
    expect(order).toEqual([]);

    (HTMLCanvasElement.prototype.getContext as jest.Mock).mockRestore();
    (HTMLCanvasElement.prototype.toDataURL as jest.Mock).mockRestore();
  });
});

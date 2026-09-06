import { createContext, useRef, useContext, useCallback, useMemo } from 'react';
import type { ReactNode, RefObject } from 'react';
import { toCanvas } from 'html-to-image';
import { ThemeContext, isDark } from '@librechat/client';

type ScreenshotMaterializer = () => Promise<() => void>;
type ScreenshotContextType = {
  ref?: RefObject<HTMLDivElement>;
  registerMaterializer?: (materializer: ScreenshotMaterializer) => () => void;
  materialize?: () => Promise<() => void>;
};

const ScreenshotContext = createContext<ScreenshotContextType>({});

export const useScreenshot = () => {
  const context = useContext(ScreenshotContext);
  const { ref, materialize } = context;
  const { theme } = useContext(ThemeContext);

  const takeScreenShot = async (node?: HTMLElement) => {
    if (!node) {
      throw new Error('You should provide correct html node.');
    }

    let restore: () => void = () => {};
    try {
      if (materialize) {
        restore = await materialize();
      }

      const backgroundColor = isDark(theme) ? '#171717' : 'white';

      const canvas = await toCanvas(node, {
        backgroundColor,
        imagePlaceholder:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      });

      const croppedCanvas = document.createElement('canvas');
      const croppedCanvasContext = croppedCanvas.getContext('2d') as CanvasRenderingContext2D;
      // init data
      const cropPositionTop = 0;
      const cropPositionLeft = 0;
      const cropWidth = canvas.width;
      const cropHeight = canvas.height;

      croppedCanvas.width = cropWidth;
      croppedCanvas.height = cropHeight;

      croppedCanvasContext.fillStyle = backgroundColor;
      croppedCanvasContext.fillRect(0, 0, cropWidth, cropHeight);

      croppedCanvasContext.drawImage(canvas, cropPositionLeft, cropPositionTop);

      const base64Image = croppedCanvas.toDataURL('image/png', 1);

      return base64Image;
    } finally {
      restore();
    }
  };

  const captureScreenshot = async () => {
    if (ref instanceof Function) {
      throw new Error('Ref callback is not supported.');
    }
    if (ref?.current) {
      return takeScreenShot(ref.current);
    }
    throw new Error('Ref is not attached to any element.');
  };

  return {
    screenshotTargetRef: ref,
    captureScreenshot,
    registerMaterializer: context.registerMaterializer,
  };
};

export const ScreenshotProvider = ({ children }: { children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null);
  const materializers = useRef<ScreenshotMaterializer[]>([]);

  const registerMaterializer = useCallback((materializer: ScreenshotMaterializer) => {
    materializers.current.push(materializer);
    return () => {
      const list = materializers.current;
      const index = list.indexOf(materializer);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }, []);

  const materialize = useCallback(async () => {
    const list = materializers.current;
    return list.length ? list[list.length - 1]() : Promise.resolve(() => {});
  }, []);

  const value = useMemo(
    () => ({ ref, registerMaterializer, materialize }),
    [registerMaterializer, materialize],
  );

  return <ScreenshotContext.Provider value={value}>{children}</ScreenshotContext.Provider>;
};

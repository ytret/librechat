import { createContext, useRef, useContext, RefObject } from 'react';
import { toCanvas } from 'html-to-image';
import { ThemeContext, isDark } from '@librechat/client';

type ScreenshotMaterializer = () => Promise<() => void>;
type ScreenshotContextType = {
  ref?: RefObject<HTMLDivElement>;
  registerMaterializer?: (materializer: ScreenshotMaterializer) => () => void;
};

const ScreenshotContext = createContext<ScreenshotContextType>({});

const contextMaterializers: ScreenshotMaterializer[] = [];

export const useScreenshot = () => {
  const context = useContext(ScreenshotContext);
  const { ref } = context;
  const { theme } = useContext(ThemeContext);

  const takeScreenShot = async (node?: HTMLElement) => {
    const restore = contextMaterializers.length
      ? await contextMaterializers[contextMaterializers.length - 1]()
      : () => {};
    try {
    if (!node) {
      throw new Error('You should provide correct html node.');
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

  return { screenshotTargetRef: ref, captureScreenshot, registerMaterializer: context.registerMaterializer };
};

export const ScreenshotProvider = ({ children }) => {
  const ref = useRef(null);

  const registerMaterializer = (materializer: ScreenshotMaterializer) => {
    contextMaterializers.push(materializer);
    return () => { const index = contextMaterializers.indexOf(materializer); if (index >= 0) contextMaterializers.splice(index, 1); };
  };
  return <ScreenshotContext.Provider value={{ ref, registerMaterializer }}>{children}</ScreenshotContext.Provider>;
};

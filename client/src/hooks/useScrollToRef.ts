import { RefObject, useCallback } from 'react';
import throttle from 'lodash/throttle';

type TUseScrollToRef = {
  targetRef: RefObject<HTMLDivElement>;
  callback: () => void;
  smoothCallback: () => void;
  /**
   * Optional predicate evaluated right before an auto-follow (instant) scroll
   * actually happens. If it returns false, the scroll is skipped. This lets the
   * caller enforce "don't teleport the user" at the moment the throttled edge
   * fires, regardless of which effect scheduled it. User-initiated smooth
   * scrolls (the scroll-to-bottom button) are never gated.
   */
  shouldScroll?: () => boolean;
};

type ThrottledFunction = (() => void) & {
  cancel: () => void;
  flush: () => void;
};

type ScrollToRefReturn = {
  scrollToRef?: ThrottledFunction;
  handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement>;
};

export default function useScrollToRef({
  targetRef,
  callback,
  smoothCallback,
  shouldScroll,
}: TUseScrollToRef): ScrollToRefReturn {
  const logAndScroll = (behavior: 'instant' | 'smooth', callbackFn: () => void) => {
    // Debugging:
    // console.log(`Scrolling with behavior: ${behavior}, Time: ${new Date().toISOString()}`);
    if (behavior === 'instant' && shouldScroll && !shouldScroll()) {
      return;
    }
    targetRef.current?.scrollIntoView({ behavior });
    callbackFn();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollToRef = useCallback(
    throttle(() => logAndScroll('instant', callback), 145, { leading: true }),
    [targetRef],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollToRefSmooth = useCallback(
    throttle(() => logAndScroll('smooth', smoothCallback), 750, { leading: true }),
    [targetRef],
  );

  const handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    scrollToRefSmooth();
  };

  return {
    scrollToRef,
    handleSmoothToRef,
  };
}

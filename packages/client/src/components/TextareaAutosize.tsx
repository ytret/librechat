import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type ForwardedRef,
  type ForwardRefExoticComponent,
  type MutableRefObject,
  type RefAttributes,
} from 'react';
import { useAtomValue } from 'jotai';
import type { TextareaAutosizeProps } from 'react-textarea-autosize';
import { chatDirectionAtom } from '~/store';

type BaseTextareaAutosizeProps = Omit<TextareaAutosizeProps, 'aria-label' | 'aria-labelledby'>;

export type TextareaAutosizePropsWithAria =
  | (BaseTextareaAutosizeProps & {
      'aria-label': string;
      'aria-labelledby'?: never;
    })
  | (BaseTextareaAutosizeProps & {
      'aria-labelledby': string;
      'aria-label'?: never;
    });

/**
 * Vendored, corrected fork of `react-textarea-autosize`.
 *
 * Upstream registers its measurement via `useLayoutEffect(resizeTextarea)` with
 * **no dependency array**, so it re-runs `getComputedStyle(node)` + 20 style reads
 * (a forced layout) on every render of the composer — including every streaming
 * chunk, even though the textarea content hasn't changed. This was measured as the
 * single largest main-thread cost while streaming (see ai-reports/02-stutter.md).
 *
 * The fixed effect below only re-measures when a height-affecting input actually
 * changes. Window resizes and font loads are still handled by the dedicated
 * listeners, and uncontrolled typing is handled by `handleChange`.
 */

const HIDDEN_TEXTAREA_STYLE = {
  'min-height': '0',
  'max-height': 'none',
  height: '0',
  visibility: 'hidden',
  overflow: 'hidden',
  position: 'absolute',
  'z-index': '-1000',
  top: '0',
  right: '0',
} as const;

const SIZING_STYLE = [
  'borderBottomWidth',
  'borderLeftWidth',
  'borderRightWidth',
  'borderTopWidth',
  'boxSizing',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  // non-standard
  'tabSize',
  'textIndent',
  // non-standard
  'textRendering',
  'textTransform',
  'width',
  'wordBreak',
] as const;

type SizingData = {
  sizingStyle: Record<string, string>;
  paddingSize: number;
  borderSize: number;
};

let hiddenTextarea: HTMLTextAreaElement | null = null;

function forceHiddenStyles(node: HTMLTextAreaElement) {
  Object.keys(HIDDEN_TEXTAREA_STYLE).forEach((key) => {
    node.style.setProperty(
      key,
      HIDDEN_TEXTAREA_STYLE[key as keyof typeof HIDDEN_TEXTAREA_STYLE],
      'important',
    );
  });
}

function getHeight(node: HTMLTextAreaElement, sizingData: SizingData) {
  const height = node.scrollHeight;
  if (sizingData.sizingStyle.boxSizing === 'border-box') {
    // border-box: add border, since height = content + padding + border
    return height + sizingData.borderSize;
  }
  // remove padding, since height = content
  return height - sizingData.paddingSize;
}

function calculateNodeHeight(
  sizingData: SizingData,
  value: string,
  minRows = 1,
  maxRows = Infinity,
): [number, number] {
  if (!hiddenTextarea) {
    hiddenTextarea = document.createElement('textarea');
    hiddenTextarea.setAttribute('tabindex', '-1');
    hiddenTextarea.setAttribute('aria-hidden', 'true');
    forceHiddenStyles(hiddenTextarea);
  }

  if (hiddenTextarea.parentNode === null) {
    document.body.appendChild(hiddenTextarea);
  }

  const { paddingSize, borderSize, sizingStyle } = sizingData;
  const boxSizing = sizingStyle.boxSizing;

  const hiddenStyle = hiddenTextarea!.style as unknown as Record<string, string>;
  Object.keys(sizingStyle).forEach((key) => {
    hiddenStyle[key] = sizingStyle[key];
  });
  forceHiddenStyles(hiddenTextarea);

  hiddenTextarea.value = value;
  let height = getHeight(hiddenTextarea, sizingData);

  // Double set and calc due to Firefox bug:
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1795904
  hiddenTextarea.value = value;
  height = getHeight(hiddenTextarea, sizingData);

  // measure height of a textarea with a single row
  hiddenTextarea.value = 'x';
  const rowHeight = hiddenTextarea.scrollHeight - paddingSize;

  let minHeight = rowHeight * minRows;
  if (boxSizing === 'border-box') {
    minHeight = minHeight + paddingSize + borderSize;
  }
  height = Math.max(minHeight, height);

  let maxHeight = rowHeight * maxRows;
  if (boxSizing === 'border-box') {
    maxHeight = maxHeight + paddingSize + borderSize;
  }
  height = Math.min(maxHeight, height);

  return [height, rowHeight];
}

const isIE = !!(
  typeof document !== 'undefined' &&
  (document.documentElement as { currentStyle?: unknown } | null)?.currentStyle
);

function getSizingData(node: HTMLTextAreaElement | null): SizingData | null {
  if (!node) {
    return null;
  }
  const style = window.getComputedStyle(node);
  if (style === null) {
    return null;
  }
  const styleRecord = style as unknown as Record<string, string>;
  const sizingStyle: Record<string, string> = {};
  for (const prop of SIZING_STYLE) {
    sizingStyle[prop] = styleRecord[prop];
  }

  const boxSizing = sizingStyle.boxSizing;

  // probably node is detached from DOM, can't read computed dimensions
  if (boxSizing === '') {
    return null;
  }

  // IE (Edge has already correct behaviour) returns content width as computed width
  // so we need to add manually padding and border widths
  if (isIE && boxSizing === 'border-box') {
    sizingStyle.width =
      (
        parseFloat(sizingStyle.width) +
        parseFloat(sizingStyle.borderRightWidth) +
        parseFloat(sizingStyle.borderLeftWidth) +
        parseFloat(sizingStyle.paddingRight) +
        parseFloat(sizingStyle.paddingLeft)
      ).toString() + 'px';
  }

  const paddingSize = parseFloat(sizingStyle.paddingBottom) + parseFloat(sizingStyle.paddingTop);
  const borderSize =
    parseFloat(sizingStyle.borderBottomWidth) + parseFloat(sizingStyle.borderTopWidth);

  return {
    sizingStyle,
    paddingSize,
    borderSize,
  };
}

const noop = () => {};

function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function updateRef<T>(ref: ForwardedRef<T> | null | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  if (ref != null) {
    (ref as MutableRefObject<T | null>).current = value;
  }
}

function useComposedRef<T>(libRef: MutableRefObject<T | null>, userRef: ForwardedRef<T>) {
  const prevUserRef = useRef<ForwardedRef<T>>();
  return useCallback(
    (instance: T | null) => {
      libRef.current = instance;

      if (prevUserRef.current) {
        updateRef(prevUserRef.current, null);
      }

      prevUserRef.current = userRef;

      if (!userRef) {
        return;
      }

      updateRef(userRef, instance);
    },
    [userRef, libRef],
  );
}

function useListener(target: EventTarget | undefined, type: string, listener: () => void) {
  const latestListener = useLatest(listener);
  useLayoutEffect(() => {
    const handler = () => latestListener.current();

    // might happen if document.fonts is not defined, for instance
    if (!target) {
      return;
    }

    target.addEventListener(type, handler);
    return () => target.removeEventListener(type, handler);
  }, [target, type, latestListener]);
}

export const TextareaAutosize: ForwardRefExoticComponent<
  TextareaAutosizePropsWithAria & RefAttributes<HTMLTextAreaElement>
> = forwardRef<HTMLTextAreaElement, TextareaAutosizePropsWithAria>((props, ref) => {
  const chatDirection = useAtomValue(chatDirectionAtom).toLowerCase();
  const {
    cacheMeasurements,
    maxRows,
    minRows,
    onChange = noop,
    onHeightChange = noop,
    ...textareaProps
  } = props;

  if (textareaProps.style) {
    if ('maxHeight' in textareaProps.style) {
      throw new Error(
        'Using `style.maxHeight` for <TextareaAutosize/> is not supported. Please use `maxRows`.',
      );
    }
    if ('minHeight' in textareaProps.style) {
      throw new Error(
        'Using `style.minHeight` for <TextareaAutosize/> is not supported. Please use `minRows`.',
      );
    }
  }

  const isControlled = textareaProps.value !== undefined;
  const libRef = useRef<HTMLTextAreaElement | null>(null);
  const composedRef = useComposedRef(libRef, ref);
  const heightRef = useRef(0);
  const measurementsCacheRef = useRef<SizingData | null>(null);

  const resizeTextarea = useCallback(() => {
    const node = libRef.current;
    if (!node) {
      return;
    }

    const nodeSizingData =
      cacheMeasurements && measurementsCacheRef.current
        ? measurementsCacheRef.current
        : getSizingData(node);

    if (!nodeSizingData) {
      return;
    }

    measurementsCacheRef.current = nodeSizingData;

    const [height, rowHeight] = calculateNodeHeight(
      nodeSizingData,
      node.value || node.placeholder || 'x',
      minRows,
      maxRows,
    );

    if (heightRef.current !== height) {
      heightRef.current = height;
      node.style.setProperty('height', `${height}px`, 'important');
      onHeightChange(height, { rowHeight });
    }
  }, [cacheMeasurements, minRows, maxRows, onHeightChange, libRef]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (!isControlled) {
      resizeTextarea();
    }
    onChange(event);
  };

  // Only re-measure when a height-affecting input changes, rather than on every
  // render (which is what upstream does and what forced full-document style
  // recalcs on every streaming chunk).
  useLayoutEffect(() => {
    resizeTextarea();
  }, [resizeTextarea, textareaProps.value]);

  useListener(window, 'resize', resizeTextarea);
  useListener(document.fonts, 'loadingdone', resizeTextarea);

  return (
    <textarea dir={chatDirection} {...textareaProps} onChange={handleChange} ref={composedRef} />
  );
});

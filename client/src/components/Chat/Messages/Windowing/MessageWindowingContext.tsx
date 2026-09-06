import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { estimateMessageHeight } from './messageHeightEstimate';
import type { MessageWindowingContextValue, PinReason, RowRegistration, RowToken } from './types';

export const OVERSCAN_PX = 1200;
export const UNMOUNT_HYSTERESIS_PX = 2400;

type Row = RowRegistration & {
  mounted: boolean;
  height: number;
  measured: boolean;
  pins: Set<PinReason>;
  waiters: Array<(el: HTMLElement | null) => void>;
};

const Context = createContext<MessageWindowingContextValue | null>(null);

function getScrollRoot(ref: React.RefObject<HTMLElement>): HTMLElement | null {
  return ref.current ?? [...document.querySelectorAll<HTMLElement>('.scrollbar-gutter-stable')].find((node) => node.querySelector('#messages-end')) ?? null;
}

export function MessageWindowingProvider({
  children,
  scrollableRef,
  conversationId,
}: {
  children: React.ReactNode;
  scrollableRef: React.RefObject<HTMLElement>;
  conversationId?: string | null;
}) {
  const rows = useRef(new Map<RowToken, Row>());
  const byId = useRef(new Map<string, Row>());
  const frame = useRef<number>();
  const correctionFrame = useRef<number>();
  const pendingCorrection = useRef(0);
  const navigationTimers = useRef(new Map<RowToken, ReturnType<typeof setTimeout>>());
  const materialized = useRef(false);
  const observer = useRef<IntersectionObserver>();
  const resize = useRef<ResizeObserver>();

  const setMounted = useCallback((row: Row, value: boolean) => {
    if (row.mounted === value) return;
    row.mounted = value;
    row.setMounted(value);
    if (value) row.waiters.splice(0).forEach((resolve) => resolve(row.element));
  }, []);

  const schedule = useCallback(() => {
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const root = getScrollRoot(scrollableRef);
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      rows.current.forEach((row) => {
        if (!row.element || materialized.current || row.forceMounted || row.pins.size) {
          if (row.element && (materialized.current || row.forceMounted || row.pins.size)) setMounted(row, true);
          return;
        }
        const box = row.element.getBoundingClientRect();
        const near = box.bottom >= bounds.top - OVERSCAN_PX && box.top <= bounds.bottom + OVERSCAN_PX;
        const far = box.bottom < bounds.top - UNMOUNT_HYSTERESIS_PX || box.top > bounds.bottom + UNMOUNT_HYSTERESIS_PX;
        if (near) setMounted(row, true);
        else if (far) setMounted(row, false);
      });
    });
  }, [scrollableRef, setMounted]);

  const reportHeight = useCallback((token: RowToken, rawHeight: number) => {
    const row = rows.current.get(token);
    if (!row || rawHeight <= 0) return;
    const height = Math.round(rawHeight * 10) / 10;
    const delta = height - row.height;
    if (!row.measured) {
      row.measured = true;
      row.height = height;
      return;
    }
    if (Math.abs(delta) < 0.1) return;
    const root = getScrollRoot(scrollableRef);
    const box = row.element?.getBoundingClientRect();
    const rootBox = root?.getBoundingClientRect();
    const atBottom = root ? root.scrollHeight - root.scrollTop - root.clientHeight < 4 : false;
    row.height = height;
    // A replacement above the viewport changes the scroll coordinate of everything below it.
    // Accumulate corrections so a stream or a batch of ResizeObserver entries writes once.
    if (root && box && rootBox && box.bottom <= rootBox.top && !atBottom) {
      pendingCorrection.current += delta;
      if (correctionFrame.current == null) {
        correctionFrame.current = requestAnimationFrame(() => {
          correctionFrame.current = undefined;
          const correction = pendingCorrection.current;
          pendingCorrection.current = 0;
          if (correction && root.isConnected) root.scrollTop += correction;
        });
      }
    }
  }, [scrollableRef]);

  const registerRow = useCallback((registration: RowRegistration) => {
    const row: Row = {
      ...registration,
      mounted: registration.forceMounted,
      height: estimateMessageHeight(registration.message),
      measured: false,
      pins: new Set(),
      waiters: [],
    };
    rows.current.set(registration.token, row);
    byId.current.set(registration.id, row);
    const root = getScrollRoot(scrollableRef);
    if (!registration.forceMounted && registration.element && root) {
      const bounds = root.getBoundingClientRect();
      const box = registration.element.getBoundingClientRect();
      const initiallyNear = box.bottom >= bounds.top - OVERSCAN_PX && box.top <= bounds.bottom + OVERSCAN_PX;
      row.mounted = initiallyNear;
      registration.setMounted(initiallyNear);
    }
    if (observer.current && registration.element) observer.current.observe(registration.element);
    if (resize.current && registration.element) resize.current.observe(registration.element);
    schedule();
    return () => {
      if (registration.element) {
        observer.current?.unobserve(registration.element);
        resize.current?.unobserve(registration.element);
      }
      rows.current.delete(registration.token);
      const navigationTimer = navigationTimers.current.get(registration.token);
      if (navigationTimer) clearTimeout(navigationTimer);
      navigationTimers.current.delete(registration.token);
      if (byId.current.get(registration.id) === row) byId.current.delete(registration.id);
      row.waiters.splice(0).forEach((resolve) => resolve(null));
    };
  }, [schedule, scrollableRef]);

  const updateRowId = useCallback((token: RowToken, oldId: string, newId: string) => {
    const row = rows.current.get(token);
    if (!row) return;
    if (byId.current.get(oldId) === row) byId.current.delete(oldId);
    row.id = newId;
    byId.current.set(newId, row);
  }, []);

  const updateRowState = useCallback((token: RowToken, message: RowRegistration['message'], forceMounted: boolean) => {
    const row = rows.current.get(token);
    if (!row) return;
    const forceChanged = row.forceMounted !== forceMounted;
    // Historical edits invalidate the placeholder estimate. Streaming rows stay
    // measured continuously by ResizeObserver and must not reset on every token.
    if (row.message !== message && !row.forceMounted && !forceMounted) {
      row.measured = false;
      row.height = estimateMessageHeight(message);
    }
    row.message = message;
    row.forceMounted = forceMounted;
    if (forceMounted) setMounted(row, true);
    else if (forceChanged) schedule();
  }, [schedule, setMounted]);

  const isMounted = useCallback((token: RowToken) => rows.current.get(token)?.mounted ?? false, []);

  const pinRow = useCallback((token: RowToken, reason: PinReason) => {
    const row = rows.current.get(token);
    if (!row) return () => {};
    row.pins.add(reason);
    setMounted(row, true);
    return () => {
      row.pins.delete(reason);
      schedule();
    };
  }, [schedule, setMounted]);

  const ensureMessageMounted = useCallback(async (id: string) => {
    const row = byId.current.get(id);
    if (!row) return null;
    row.pins.add('navigation');
    setMounted(row, true);
    const previousTimer = navigationTimers.current.get(row.token);
    if (previousTimer) clearTimeout(previousTimer);
    navigationTimers.current.set(row.token, setTimeout(() => {
      row.pins.delete('navigation');
      navigationTimers.current.delete(row.token);
      schedule();
    }, 2500));
    if (!row.element) return new Promise<HTMLElement | null>((resolve) => row.waiters.push(resolve));
    // The shell is already present, but the expensive subtree is committed on the
    // next React turn. Let it render and measure before navigation reads geometry.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return row.element;
  }, [schedule, setMounted]);

  const materializeAll = useCallback(async (reason: 'screenshot' | 'find' | 'debug') => {
    const root = getScrollRoot(scrollableRef);
    const previousScrollTop = root?.scrollTop;
    materialized.current = true;
    rows.current.forEach((row) => setMounted(row, true));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (typeof document.fonts?.ready?.then === 'function') await document.fonts.ready;
    return () => {
      // Native find has no close event. Keep the complete DOM until the conversation changes.
      if (reason === 'find') return;
      materialized.current = false;
      if (root && previousScrollTop != null) root.scrollTop = previousScrollTop;
      schedule();
    };
  }, [schedule, scrollableRef, setMounted]);

  const value = useMemo(() => ({
    registerRow,
    updateRowId,
    updateRowState,
    reportHeight,
    isMounted,
    pinRow,
    ensureMessageMounted,
    materializeAll,
    notifyLayoutChange: schedule,
  }), [registerRow, updateRowId, updateRowState, reportHeight, isMounted, pinRow, ensureMessageMounted, materializeAll, schedule]);

  useEffect(() => {
    const root = getScrollRoot(scrollableRef);
    if (!root) return;
    materialized.current = false;
    observer.current = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(schedule, { root, rootMargin: `${OVERSCAN_PX}px 0px`, threshold: 0 })
      : undefined;
    resize.current = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver((entries) => entries.forEach((entry) => {
          const row = [...rows.current.values()].find((item) => item.element === entry.target);
          if (row) reportHeight(row.token, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        }))
      : undefined;
    // Child effects can register rows before this provider effect creates the
    // observers. Attach those already-mounted shells as well.
    rows.current.forEach((row) => {
      if (!row.element) return;
      observer.current?.observe(row.element);
      resize.current?.observe(row.element);
    });
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') void materializeAll('find');
    };
    let previousWidth = root.clientWidth;
    const onResize = () => {
      const width = root.clientWidth;
      if (Math.abs(width - previousWidth) < 16) return;
      previousWidth = width;
      rows.current.forEach((row) => {
        row.measured = false;
        row.height = estimateMessageHeight(row.message);
      });
      schedule();
    };
    const selectionPins = new Map<RowToken, () => void>();
    const onSelectionChange = () => {
      selectionPins.forEach((release) => release());
      selectionPins.clear();
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      [selection.anchorNode, selection.focusNode].forEach((node) => {
        const shell = node instanceof Element ? node.closest<HTMLElement>('[data-message-virtual-row="true"]') : node?.parentElement?.closest<HTMLElement>('[data-message-virtual-row="true"]');
        if (!shell) return;
        const row = [...rows.current.values()].find((candidate) => candidate.element === shell);
        if (row && !selectionPins.has(row.token)) selectionPins.set(row.token, pinRow(row.token, 'selection'));
      });
    };
    root.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onFind, true);
    document.addEventListener('selectionchange', onSelectionChange);
    schedule();
    return () => {
      root.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onFind, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      selectionPins.forEach((release) => release());
      selectionPins.clear();
      observer.current?.disconnect();
      resize.current?.disconnect();
      if (frame.current != null) cancelAnimationFrame(frame.current);
      if (correctionFrame.current != null) cancelAnimationFrame(correctionFrame.current);
      navigationTimers.current.forEach((timer) => clearTimeout(timer));
      navigationTimers.current.clear();
      rows.current.clear();
      byId.current.clear();
    };
  }, [conversationId, materializeAll, reportHeight, schedule, scrollableRef]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useMessageWindowing() {
  const context = useContext(Context);
  if (!context) throw new Error('useMessageWindowing must be used within MessageWindowingProvider');
  return context;
}

export function useOptionalMessageWindowing() {
  return useContext(Context);
}

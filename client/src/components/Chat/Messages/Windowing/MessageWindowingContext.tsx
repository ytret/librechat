import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { estimateMessageHeight } from './messageHeightEstimate';
import type { MessageWindowingContextValue, PinReason, RowRegistration, RowToken } from './types';
import { MESSAGE_CONTENT_LAYOUT_CHANGE_EVENT } from '~/hooks/Messages/messageLayout';

export const OVERSCAN_PX = 1200;
export const UNMOUNT_HYSTERESIS_PX = 2400;
/** Upper bound for waiting on a post-mount measurement during a navigation jump. */
export const NAVIGATION_MEASUREMENT_TIMEOUT_MS = 250;
/** Upper bound for settling mounts before a screenshot/debug capture. A real
 *  timeout (not just two RAFs) guarantees cleanup still runs when animation
 *  frames are suspended (background tab, throttled webview, etc.). */
export const MATERIALIZE_SETTLE_TIMEOUT_MS = 500;

type Row = RowRegistration & {
  mounted: boolean;
  height: number;
  measured: boolean;
  /** True after a placeholder→mounted transition. The first measurement that
   *  arrives while this is set replaces the estimate and must apply anchor
   *  correction. Initially/force-mounted rows never set this, so their first
   *  measurement establishes a baseline without correcting. */
  pendingAnchorCorrection: boolean;
  /** Incremented on every accepted ResizeObserver measurement. Navigation uses
   *  it to distinguish a stale placeholder measurement from the measurement of
   *  the freshly mounted subtree. */
  measureVersion: number;
  pins: Set<PinReason>;
  waiters: Array<(el: HTMLElement | null) => void>;
  measureWaiters: Array<() => void>;
};

export const MessageWindowingContext = createContext<MessageWindowingContextValue | null>(null);
const Context = MessageWindowingContext;

function getScrollRoot(ref: React.RefObject<HTMLElement>): HTMLElement | null {
  return (
    ref.current ??
    [...document.querySelectorAll<HTMLElement>('.scrollbar-gutter-stable')].find((node) =>
      node.querySelector('#messages-end'),
    ) ??
    null
  );
}

export function MessageWindowingProvider({
  children,
  scrollableRef,
  conversationId,
  pinnedToBottomRef,
}: {
  children: React.ReactNode;
  scrollableRef: React.RefObject<HTMLElement>;
  conversationId?: string | null;
  /** Sticky "user is pinned to the bottom" signal, owned by useMessageScrolling.
   *  Set synchronously when the app programmatically scrolls to the bottom and
   *  cleared only on a deliberate scroll-away. Unlike a per-row capture or a
   *  scroll-event read, it survives the multi-batch settling of placeholder →
   *  measured heights (where rows above the viewport grow before the bottom row
   *  mounts). Optional so the provider can be rendered in isolation (tests). */
  pinnedToBottomRef?: React.RefObject<boolean>;
}) {
  const rows = useRef(new Map<RowToken, Row>());
  const byId = useRef(new Map<string, Row>());
  const elementToRow = useRef(new WeakMap<Element, Row>());
  const pinnedToBottomFallbackRef = useRef(false);
  const pinnedToBottom = pinnedToBottomRef ?? pinnedToBottomFallbackRef;
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
    if (value) {
      // Placeholder → mounted: the shell's layout height is about to change
      // from its cached/estimated height to real content, so the next
      // measurement is an estimate→measured correction candidate.
      row.pendingAnchorCorrection = true;
    }
    // Hand the row its latest measured height when it becomes a placeholder so
    // the placeholder preserves real geometry rather than falling back to the
    // estimate. Mounting uses automatic height and therefore passes nothing.
    row.setMounted(value, value ? undefined : row.height);
    if (value) row.waiters.splice(0).forEach((resolve) => resolve(row.element));
  }, []);

  const schedule = useCallback(() => {
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const root = getScrollRoot(scrollableRef);
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      // Batch all geometry reads before applying any mount/unmount writes. A
      // write cannot invalidate the measurements of a later row in the same pass.
      const decisions: Array<{ row: Row; mount: boolean }> = [];
      rows.current.forEach((row) => {
        if (!row.element) return;
        if (materialized.current || row.forceMounted || row.pins.size) {
          decisions.push({ row, mount: true });
          return;
        }
        const box = row.element.getBoundingClientRect();
        const near =
          box.bottom >= bounds.top - OVERSCAN_PX && box.top <= bounds.bottom + OVERSCAN_PX;
        const far =
          box.bottom < bounds.top - UNMOUNT_HYSTERESIS_PX ||
          box.top > bounds.bottom + UNMOUNT_HYSTERESIS_PX;
        if (near) decisions.push({ row, mount: true });
        else if (far) decisions.push({ row, mount: false });
      });
      decisions.forEach(({ row, mount }) => setMounted(row, mount));
    });
  }, [scrollableRef, setMounted]);

  const reportHeight = useCallback(
    (token: RowToken, rawHeight: number) => {
      const row = rows.current.get(token);
      if (!row || rawHeight <= 0) return;
      const height = Math.round(rawHeight * 10) / 10;
      const firstMeasurement = !row.measured;
      const oldHeight = row.height;
      const delta = height - oldHeight;
      row.measured = true;
      row.height = height;
      row.measureVersion += 1;
      // Signal any pending navigation that a real measurement is now available.
      // Each waiter self-checks that the version has advanced past its own
      // snapshot, so a stale placeholder measurement cannot resolve a jump that
      // requested a freshly mounted subtree.
      row.measureWaiters.splice(0).forEach((resolve) => resolve());
      if (firstMeasurement && !row.pendingAnchorCorrection) {
        // A row mounted from its very first render already had its real DOM
        // height participating in layout. Recording that measurement changes
        // nothing on the page, so establish the baseline without any correction.
        // Correcting `measured - estimate` here would create an artificial jump.
        return;
      }
      row.pendingAnchorCorrection = false;
      if (Math.abs(delta) < 0.1) return;
      const root = getScrollRoot(scrollableRef);
      if (!root) return;
      if (pinnedToBottom.current) {
        // The user is pinned to the bottom. The initial scroll-to-end ran against
        // placeholder heights, so as each row's real height replaces its estimate
        // the pinned viewport must follow the new bottom — otherwise it lands in
        // the middle of the last message. Clamping to the bottom is absolute and
        // idempotent, so it is correct regardless of which row changed, whether it
        // grew or shrank, and in what order the many rows mount/measure.
        if (correctionFrame.current == null) {
          correctionFrame.current = requestAnimationFrame(() => {
            correctionFrame.current = undefined;
            pendingCorrection.current = 0;
            if (root.isConnected) {
              root.scrollTop = root.scrollHeight - root.clientHeight;
            }
          });
        }
        return;
      }
      // Not pinned: a replacement above the viewport changes the scroll coordinate
      // of everything below it, so keep the visible content stable.
      const box = row.element?.getBoundingClientRect();
      const rootBox = root?.getBoundingClientRect();
      if (rootBox && box && box.bottom <= rootBox.top) {
        // Accumulate corrections so a stream or a batch of ResizeObserver entries
        // writes once per frame.
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
    },
    [pinnedToBottom, scrollableRef],
  );

  const registerRow = useCallback(
    (registration: RowRegistration) => {
      const row: Row = {
        ...registration,
        mounted: registration.forceMounted,
        height: estimateMessageHeight(registration.message),
        measured: false,
        pendingAnchorCorrection: false,
        measureVersion: 0,
        pins: new Set(),
        waiters: [],
        measureWaiters: [],
      };
      rows.current.set(registration.token, row);
      byId.current.set(registration.id, row);
      if (registration.element) elementToRow.current.set(registration.element, row);
      const root = getScrollRoot(scrollableRef);
      if (!registration.forceMounted && registration.element && root) {
        const bounds = root.getBoundingClientRect();
        const box = registration.element.getBoundingClientRect();
        const initiallyNear =
          box.bottom >= bounds.top - OVERSCAN_PX && box.top <= bounds.bottom + OVERSCAN_PX;
        if (initiallyNear) setMounted(row, true);
      }
      if (observer.current && registration.element) observer.current.observe(registration.element);
      if (resize.current && registration.element) resize.current.observe(registration.element);
      schedule();
      return () => {
        if (registration.element) {
          observer.current?.unobserve(registration.element);
          resize.current?.unobserve(registration.element);
          elementToRow.current.delete(registration.element);
        }
        rows.current.delete(registration.token);
        const navigationTimer = navigationTimers.current.get(registration.token);
        if (navigationTimer) clearTimeout(navigationTimer);
        navigationTimers.current.delete(registration.token);
        if (byId.current.get(registration.id) === row) byId.current.delete(registration.id);
        row.waiters.splice(0).forEach((resolve) => resolve(null));
        row.measureWaiters.splice(0).forEach((resolve) => resolve());
      };
    },
    [schedule, scrollableRef, setMounted],
  );

  const updateRowId = useCallback((token: RowToken, oldId: string, newId: string) => {
    const row = rows.current.get(token);
    if (!row) return;
    if (byId.current.get(oldId) === row) byId.current.delete(oldId);
    row.id = newId;
    byId.current.set(newId, row);
  }, []);

  const updateRowState = useCallback(
    (token: RowToken, message: RowRegistration['message'], forceMounted: boolean) => {
      const row = rows.current.get(token);
      if (!row) return;
      const forceChanged = row.forceMounted !== forceMounted;
      // Historical edits invalidate the placeholder estimate. Streaming rows stay
      // measured continuously by ResizeObserver and must not reset on every token.
      if (row.message !== message && !row.forceMounted && !forceMounted) {
        row.measured = false;
        row.height = estimateMessageHeight(message);
        // This is a content/edit invalidation, not a placeholder→mounted
        // transition, so the next measurement must not trigger an estimate
        // anchor correction.
        row.pendingAnchorCorrection = false;
      }
      row.message = message;
      row.forceMounted = forceMounted;
      if (forceMounted) setMounted(row, true);
      else if (forceChanged) schedule();
    },
    [schedule, setMounted],
  );

  const isMounted = useCallback((token: RowToken) => rows.current.get(token)?.mounted ?? false, []);

  const pinRow = useCallback(
    (token: RowToken, reason: PinReason) => {
      const row = rows.current.get(token);
      if (!row) return () => {};
      row.pins.add(reason);
      setMounted(row, true);
      return () => {
        row.pins.delete(reason);
        schedule();
      };
    },
    [schedule, setMounted],
  );

  const ensureMessageMounted = useCallback(
    async (id: string) => {
      const row = byId.current.get(id);
      if (!row) return null;
      row.pins.add('navigation');
      const wasMounted = row.mounted;
      const versionBefore = row.measureVersion;
      setMounted(row, true);
      const previousTimer = navigationTimers.current.get(row.token);
      if (previousTimer) clearTimeout(previousTimer);
      navigationTimers.current.set(
        row.token,
        setTimeout(() => {
          row.pins.delete('navigation');
          navigationTimers.current.delete(row.token);
          schedule();
        }, 2500),
      );
      if (!row.element)
        return new Promise<HTMLElement | null>((resolve) => row.waiters.push(resolve));
      // A row that was already mounted before this request exposes real, current
      // geometry — there is nothing further to wait for.
      if (wasMounted && row.measured) return row.element;
      // Otherwise the shell was a placeholder (or a just-mounted, still-unmeasured
      // row). Placeholders are also observed by ResizeObserver, so `measured` can
      // be true from a stale placeholder measurement. Wait for a *new* measurement
      // after mounting (a measureVersion advance), bounded by a real timeout so the
      // jump can never hang when the mounted height happens to equal the placeholder.
      return new Promise<HTMLElement | null>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve(row.element);
        };
        const onMeasurement = () => {
          if (row.measureVersion > versionBefore) {
            clearTimeout(timer);
            settle();
          }
        };
        const onTimeout = () => {
          const index = row.measureWaiters.indexOf(onMeasurement);
          if (index >= 0) row.measureWaiters.splice(index, 1);
          settle();
        };
        row.measureWaiters.push(onMeasurement);
        const timer = setTimeout(onTimeout, NAVIGATION_MEASUREMENT_TIMEOUT_MS);
      });
    },
    [schedule, setMounted],
  );

  const materializeAll = useCallback(
    async (reason: 'screenshot' | 'find' | 'debug') => {
      const root = getScrollRoot(scrollableRef);
      const previousScrollTop = root?.scrollTop;
      materialized.current = true;
      rows.current.forEach((row) => setMounted(row, true));
      const cleanup = () => {
        // Native find has no close event. Keep the complete DOM until the conversation changes.
        if (reason === 'find') return;
        materialized.current = false;
        if (root && previousScrollTop != null) root.scrollTop = previousScrollTop;
        schedule();
      };
      try {
        // Wait for React to commit the mounts and settle layout (two frames),
        // bounded by a real timeout so the capture and its cleanup can never
        // hang when RAF is suspended.
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          requestAnimationFrame(() => requestAnimationFrame(done));
          setTimeout(done, MATERIALIZE_SETTLE_TIMEOUT_MS);
        });
        if (typeof document.fonts?.ready?.then === 'function') await document.fonts.ready;
      } catch (err) {
        // If settling fails, still restore normal windowing rather than leaving every
        // row mounted, then propagate the error to the caller.
        cleanup();
        throw err;
      }
      return cleanup;
    },
    [schedule, scrollableRef, setMounted],
  );

  // Browser find must have text present in the DOM before the native default
  // action runs, so materialization is committed synchronously at the event
  // boundary. Fonts/layout settling is intentionally skipped here.
  const materializeAllSync = useCallback(() => {
    materialized.current = true;
    flushSync(() => {
      rows.current.forEach((row) => setMounted(row, true));
    });
  }, [setMounted]);

  const value = useMemo(
    () => ({
      registerRow,
      updateRowId,
      updateRowState,
      reportHeight,
      isMounted,
      pinRow,
      ensureMessageMounted,
      materializeAll,
      notifyLayoutChange: schedule,
    }),
    [
      registerRow,
      updateRowId,
      updateRowState,
      reportHeight,
      isMounted,
      pinRow,
      ensureMessageMounted,
      materializeAll,
      schedule,
    ],
  );

  useEffect(() => {
    const root = getScrollRoot(scrollableRef);
    if (!root) return;
    materialized.current = false;
    observer.current =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(schedule, {
            root,
            rootMargin: `${OVERSCAN_PX}px 0px`,
            threshold: 0,
          })
        : undefined;
    resize.current =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver((entries) =>
            entries.forEach((entry) => {
              const row = elementToRow.current.get(entry.target);
              if (row)
                reportHeight(
                  row.token,
                  entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height,
                );
            }),
          )
        : undefined;
    // Child effects can register rows before this provider effect creates the
    // observers. Attach those already-mounted shells as well.
    rows.current.forEach((row) => {
      if (!row.element) return;
      observer.current?.observe(row.element);
      resize.current?.observe(row.element);
    });
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') materializeAllSync();
    };
    let previousWidth = root.clientWidth;
    const onResize = () => {
      const width = root.clientWidth;
      if (Math.abs(width - previousWidth) < 16) return;
      previousWidth = width;
      rows.current.forEach((row) => {
        row.measured = false;
        row.height = estimateMessageHeight(row.message);
        row.pendingAnchorCorrection = false;
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
        const shell =
          node instanceof Element
            ? node.closest<HTMLElement>('[data-message-virtual-row="true"]')
            : node?.parentElement?.closest<HTMLElement>('[data-message-virtual-row="true"]');
        if (!shell) return;
        const row = elementToRow.current.get(shell);
        if (row && !selectionPins.has(row.token))
          selectionPins.set(row.token, pinRow(row.token, 'selection'));
      });
    };
    const onLayoutChange = (event: Event) => {
      const target = event.target;
      const shell =
        target instanceof Element
          ? target.closest<HTMLElement>('[data-message-virtual-row="true"]')
          : null;
      const row = shell ? elementToRow.current.get(shell) : undefined;
      if (row) {
        row.measured = false;
        row.height = estimateMessageHeight(row.message);
        row.pendingAnchorCorrection = false;
      }
      schedule();
    };
    root.addEventListener('scroll', schedule, { passive: true });
    root.addEventListener(MESSAGE_CONTENT_LAYOUT_CHANGE_EVENT, onLayoutChange);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onFind, true);
    document.addEventListener('selectionchange', onSelectionChange);
    schedule();
    return () => {
      root.removeEventListener('scroll', schedule);
      root.removeEventListener(MESSAGE_CONTENT_LAYOUT_CHANGE_EVENT, onLayoutChange);
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
      elementToRow.current = new WeakMap<Element, Row>();
    };
  }, [conversationId, materializeAllSync, reportHeight, schedule, scrollableRef]);

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

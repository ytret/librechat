import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type {
  ContentRowPinReason,
  ContentRowToken,
  ContentRowWindowingRuntime,
} from './contentRowTypes';

/**
 * Row-scoped interaction pins (spec `ai-reports/09-content-row-dom-windowing-spec.md` §15.1,
 * report 13 §6 Q5).
 *
 * The row owns the interactions of its own subtree: it has the token and a lifecycle that ends
 * exactly when the row leaves the tree, so listeners, releases, and fallback timers can all be
 * cleaned up in one place. Rows that care about a widget inside them — an expansion transition,
 * an open portal — reach the row through this context instead of the provider, so a descendant
 * never needs to know a row token.
 *
 * With the feature flag off, or with no provider above the row, there is no context value and
 * every operation here is a no-op. That is what keeps the flag the complete rollback: an
 * unflagged tree installs no listeners at all.
 */

/** The pin and containment half of the row API; the row wrapper owns this itself. */
export type ContentRowPins = {
  /** Hold this row mounted for a reason. Returns the release function. */
  pinRow(reason: ContentRowPinReason): () => void;
  /**
   * Register an element that is rendered in a portal but belongs to this row (§15.2), so focus
   * moving into the portal is not mistaken for focus leaving the row. Returns the release
   * function.
   */
  registerPortal(element: HTMLElement | null): () => void;
  /** True when the node is inside the row's subtree or one of its registered portals. */
  containsNode(node: Node | null): boolean;
};

/** The asynchronous-content half of the row API; the row wrapper derives it from its own state. */
export type ContentRowReadiness = {
  /**
   * Report this row's asynchronous content as loaded and painted (§8.2, §6 Q3). A row whose policy
   * is `unstable-until-settled` becomes `windowed` on this signal; a row with any other policy
   * ignores it. Idempotent, and scoped to the generation that was mounted when it was called.
   */
  reportReady(): void;
  /**
   * Report that the asynchronous content cannot load (§6 Q3 item 4). The row keeps its content
   * mounted rather than reserving geometry for something that will never arrive.
   */
  reportFailed(): void;
};

/** Everything a row subtree may ask of the row that contains it. */
export type ContentRowInteraction = ContentRowPins & ContentRowReadiness;

const ContentRowInteractionContext = createContext<ContentRowInteraction | null>(null);

/** The interaction API of the enclosing row, or null when no row owns this subtree. */
export function useContentRowInteraction(): ContentRowInteraction | null {
  return useContext(ContentRowInteractionContext);
}

/**
 * The readiness API of the enclosing row, or null when no row owns this subtree.
 *
 * Asynchronous renderers — images, and later Mermaid and artifacts — call this when their content
 * has arrived, so the row can decide whether it is bounded and settled enough to window (§6 Q3).
 * A renderer outside a row (the fixture, a subagent dialog, the feature flag off) gets null and
 * reports nothing.
 */
export function useContentRowReadiness(): ContentRowReadiness | null {
  const interaction = useContext(ContentRowInteractionContext);
  if (interaction == null) {
    return null;
  }
  return interaction;
}

/** Supplies the row interaction API to a row's subtree. */
export function ContentRowInteractionProvider({
  value,
  children,
}: {
  value: ContentRowInteraction;
  children: React.ReactNode;
}) {
  return (
    <ContentRowInteractionContext.Provider value={value}>
      {children}
    </ContentRowInteractionContext.Provider>
  );
}

export type ContentRowInteractionHandlers = {
  onFocus: React.FocusEventHandler<HTMLElement>;
  onBlur: React.FocusEventHandler<HTMLElement>;
  onPointerDown: React.PointerEventHandler<HTMLElement>;
};

/**
 * The interaction pins of one row (§6 Q5):
 *
 * - `focusin` acquires `focus`; `focusout` releases it on the next task, and only when focus is
 *   outside the row and its registered portals;
 * - `pointerdown` acquires `interaction`; `pointerup`, `pointercancel`, or a window blur releases
 *   it;
 * - the window listeners exist only while a pointer interaction is active;
 * - every listener, release, and pending timer is cleaned up on unmount.
 */
export function useContentRowInteractionPins({
  windowing,
  token,
  shellRef,
}: {
  windowing: ContentRowWindowingRuntime;
  token: ContentRowToken;
  shellRef: React.RefObject<HTMLElement>;
}): { interaction: ContentRowPins; handlers: ContentRowInteractionHandlers } {
  const portals = useRef<Set<HTMLElement>>(new Set());
  const focusRelease = useRef<(() => void) | null>(null);
  const focusReleaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRelease = useRef<(() => void) | null>(null);
  const pointerListenersAttached = useRef(false);

  const containsNode = useCallback(
    (node: Node | null): boolean => {
      if (node == null) {
        return false;
      }
      if (shellRef.current?.contains(node) === true) {
        return true;
      }
      for (const portal of portals.current) {
        if (portal.contains(node)) {
          return true;
        }
      }
      return false;
    },
    [shellRef],
  );

  const cancelFocusTimer = useCallback(() => {
    if (focusReleaseTimer.current != null) {
      clearTimeout(focusReleaseTimer.current);
      focusReleaseTimer.current = null;
    }
  }, []);

  const releaseFocus = useCallback(() => {
    const release = focusRelease.current;
    focusRelease.current = null;
    release?.();
  }, []);

  const releasePointer = useCallback(() => {
    if (!pointerListenersAttached.current) {
      return;
    }
    pointerListenersAttached.current = false;
    window.removeEventListener('pointerup', releasePointer);
    window.removeEventListener('pointercancel', releasePointer);
    window.removeEventListener('blur', releasePointer);
    const release = pointerRelease.current;
    pointerRelease.current = null;
    release?.();
  }, []);

  const handleFocus = useCallback(() => {
    cancelFocusTimer();
    if (focusRelease.current == null) {
      focusRelease.current = windowing.pinRow(token, 'focus');
    }
  }, [cancelFocusTimer, token, windowing]);

  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (containsNode(event.relatedTarget as Node | null)) {
        return;
      }
      cancelFocusTimer();
      focusReleaseTimer.current = setTimeout(() => {
        focusReleaseTimer.current = null;
        // Re-check at fire time: focus can move between two children of the same row, or back
        // into the row, before this task runs.
        if (containsNode(document.activeElement)) {
          return;
        }
        releaseFocus();
      }, 0);
    },
    [cancelFocusTimer, containsNode, releaseFocus],
  );

  const handlePointerDown = useCallback(() => {
    if (pointerRelease.current == null) {
      pointerRelease.current = windowing.pinRow(token, 'interaction');
    }
    // The window listeners exist only while a pointer interaction is in flight, so a row that is
    // never pointer-pressed adds nothing to the window.
    if (!pointerListenersAttached.current) {
      pointerListenersAttached.current = true;
      window.addEventListener('pointerup', releasePointer);
      window.addEventListener('pointercancel', releasePointer);
      window.addEventListener('blur', releasePointer);
    }
  }, [releasePointer, token, windowing]);

  useEffect(
    () => () => {
      cancelFocusTimer();
      releaseFocus();
      releasePointer();
      portals.current.clear();
    },
    [cancelFocusTimer, releaseFocus, releasePointer],
  );

  const interaction = useMemo<ContentRowPins>(
    () => ({
      pinRow: (reason: ContentRowPinReason) => windowing.pinRow(token, reason),
      registerPortal: (element: HTMLElement | null) => {
        if (element == null) {
          return () => {};
        }
        portals.current.add(element);
        return () => {
          portals.current.delete(element);
        };
      },
      containsNode,
    }),
    [containsNode, token, windowing],
  );

  const handlers = useMemo<ContentRowInteractionHandlers>(
    () => ({ onFocus: handleFocus, onBlur: handleBlur, onPointerDown: handlePointerDown }),
    [handleBlur, handleFocus, handlePointerDown],
  );

  return { interaction, handlers };
}

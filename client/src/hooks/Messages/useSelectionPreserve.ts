import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

type SelectionOffsets = {
  start: number;
  end: number;
};

type TextNodePosition = {
  node: Text;
  offset: number;
};

/**
 * Reads the current selection as character offsets relative to the text content
 * of `root`, but only when both endpoints sit inside `root`. Offsets are
 * measured in the *rendered* text (the same text `range.toString()` exposes),
 * so they stay stable while streaming appends to the tail of the message.
 */
const readSelectionOffsets = (root: HTMLElement | null): SelectionOffsets | null => {
  if (root == null || !root.isConnected) {
    return null;
  }
  const selection = window.getSelection();
  if (
    selection == null ||
    selection.rangeCount === 0 ||
    selection.isCollapsed ||
    selection.anchorNode == null ||
    selection.focusNode == null
  ) {
    return null;
  }
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
    return null;
  }

  const range = document.createRange();
  try {
    range.selectNodeContents(root);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    const anchor = range.toString().length;
    range.selectNodeContents(root);
    range.setEnd(selection.focusNode, selection.focusOffset);
    const focus = range.toString().length;
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  } catch {
    return null;
  }
};

/** Maps a character offset back to a concrete text-node position within `root`. */
const resolveTextOffset = (root: HTMLElement, target: number): TextNodePosition | null => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let position = 0;
  let last: Text | null = null;
  let node: Node | null;
  while ((node = walker.nextNode()) != null) {
    const textNode = node as Text;
    const length = textNode.nodeValue?.length ?? 0;
    last = textNode;
    if (target <= position + length) {
      return { node: textNode, offset: target - position };
    }
    position += length;
  }
  return last == null ? null : { node: last, offset: last.nodeValue?.length ?? 0 };
};

/** Recreates a text selection for `offsets` inside `root`. */
const restoreSelection = (root: HTMLElement | null, offsets: SelectionOffsets): boolean => {
  if (root == null || !root.isConnected) {
    return false;
  }
  const selection = window.getSelection();
  const start = resolveTextOffset(root, offsets.start);
  const end = resolveTextOffset(root, offsets.end);
  if (selection == null || start == null || end == null) {
    return false;
  }
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
};

/**
 * Preserves a text selection across React re-renders of a streaming message.
 *
 * Streaming markdown/thinking re-renders replace the DOM nodes a selection is
 * anchored to, which makes the browser relocate the selection to a block
 * boundary (or collapse it). Because streaming is append-only, the selection's
 * character offsets in already-rendered text are stable, so we can capture them
 * before React commits and restore them afterwards whenever the commit moved
 * the selection.
 */
export default function useSelectionPreserve(
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): void {
  const preCommitRef = useRef<SelectionOffsets | null>(null);
  const wasEnabledRef = useRef(false);

  // Capture during render, before React mutates the DOM in the commit phase.
  // Stay active one render past the stream so the final commit (which flips
  // `isSubmitting` off) still has a pre-commit snapshot to restore from.
  if (enabled || wasEnabledRef.current) {
    preCommitRef.current = readSelectionOffsets(rootRef.current);
  }

  useLayoutEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;

    if (!enabled && !wasEnabled) {
      return;
    }

    const pre = preCommitRef.current;
    if (pre == null) {
      return;
    }

    const current = readSelectionOffsets(rootRef.current);
    if (current == null || current.start !== pre.start || current.end !== pre.end) {
      restoreSelection(rootRef.current, pre);
    }

    if (!enabled) {
      preCommitRef.current = null;
    }
  });
}

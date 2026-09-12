import { useCallback, useEffect, useState } from 'react';

/**
 * Expansion state for one individual tool.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md` §20.6.1.
 * Decisions: `ai-reports/13-stage-3-conservative-non-text-rows.md` §6 Q2 (task 3.3).
 *
 * Every tool toggle in the chat tree has the same two-part shape: a default derived from the
 * auto-expand setting and the tool's content, and a user decision on top. Only the user
 * decision is lifted, into `ContentParts`' expansion owner, so it survives the unmount and
 * remount of the row that carries the tool. The derived default deliberately stays here,
 * because only the tool knows whether it has content (`!!command`, `!!code`, `output.length`,
 * source count, …); re-deriving it in the owner would duplicate that knowledge per tool.
 *
 * Uncontrolled by default: with no owner above it, this behaves exactly as the local
 * `useState`/effect pair it replaces. Tool rows are `always-mounted` in Stage 3, so no tool
 * unmounts yet; this is the preparatory half of §20.6.1/§20.6.2. The §20.6.2 claim that an
 * idle expanded historical tool can unmount stays deferred until a bounded tool policy is
 * enabled.
 */

export type ToolExpansion = {
  isExpanded: boolean;
  toggle: () => void;
  /** True when an owner above supplied both a key and a change handler. */
  isControlled: boolean;
};

export default function useToolExpansion({
  defaultExpanded,
  expansionKey,
  isExpanded: liftedIsExpanded,
  onExpansionChange,
  onExpand,
}: {
  /** Derived each render from settings and content; latched once true, as before. */
  defaultExpanded: boolean;
  /** Stable identity of this tool. Part of the controlled API; optional. */
  expansionKey?: string;
  /** Lifted expansion state. Used only when the owner supplied a key. */
  isExpanded?: boolean;
  /** Reports a user change to the owner. Must be referentially stable. */
  onExpansionChange?: (expansionKey: string, isExpanded: boolean) => void;
  /** Notifies an enclosing tool group that one of its tools was opened. */
  onExpand?: () => void;
}): ToolExpansion {
  const isControlled = expansionKey != null && onExpansionChange != null;
  const [localIsExpanded, setLocalIsExpanded] = useState(defaultExpanded);

  useEffect(() => {
    if (defaultExpanded) {
      setLocalIsExpanded(true);
    }
  }, [defaultExpanded]);

  /**
   * When controlled, a lifted decision wins and the latched local value is the fallback, so the
   * auto-expand behaviour is unchanged for a tool the user has not touched.
   */
  const isExpanded = isControlled ? (liftedIsExpanded ?? localIsExpanded) : localIsExpanded;

  const toggle = useCallback(() => {
    const next = !isExpanded;
    if (next) {
      onExpand?.();
    }
    if (isControlled) {
      onExpansionChange(expansionKey, next);
      return;
    }
    setLocalIsExpanded(next);
  }, [isControlled, isExpanded, onExpand, onExpansionChange, expansionKey]);

  return { isExpanded, toggle, isControlled };
}

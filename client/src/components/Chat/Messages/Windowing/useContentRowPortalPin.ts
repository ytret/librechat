import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useContentRowInteraction } from './contentRowInteraction';

/**
 * The portal pin (spec `ai-reports/09-content-row-dom-windowing-spec.md` §15.2, report 13 §6 Q5).
 *
 * A component that opens a dialog, popover, menu, or hover card outside the row subtree pins its
 * row *before* opening and releases *after* closing. The pin is what keeps the row mounted while
 * its portaled UI is on screen; that UI lives in the row's React tree even though its DOM does
 * not, so unmounting the row would tear the portal down under the user.
 *
 * `acquire` also registers the portaled element with the row, so focus moving into the portal is
 * not mistaken for focus leaving the row (§15.1). DOM focus alone is deliberately not the signal
 * here: a portal can be open with focus elsewhere, and focus can be inside a row with no portal
 * involved at all.
 *
 * Both operations are idempotent: re-acquiring while held neither adds a second pin nor duplicates
 * the portal registration, which is what makes it safe for a caller to acquire again when the
 * portaled element arrives after the open state changed. Unmount releases, so a caller that forgets
 * to release cannot pin a row forever.
 *
 * With no row above it — feature flag off, no provider, a subagent dialog — every operation is
 * inert.
 */

export type ContentRowPortalPin = {
  /** Hold the enclosing row for `portal`, and register the portaled element. Idempotent. */
  acquire(element?: HTMLElement | null): void;
  /** Release the pin and the registration. Idempotent. */
  release(): void;
  /** True while the row is being held. */
  isHeld(): boolean;
};

export function useContentRowPortalPin(): ContentRowPortalPin {
  const interaction = useContentRowInteraction();
  const releaseRow = useRef<(() => void) | null>(null);
  const releasePortal = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    const releasePortaledElement = releasePortal.current;
    releasePortal.current = null;
    releasePortaledElement?.();
    const releaseRowPin = releaseRow.current;
    releaseRow.current = null;
    releaseRowPin?.();
  }, []);

  /** A caller that never releases must not leave the row pinned after it is gone. */
  useEffect(() => release, [release]);

  const acquire = useCallback(
    (element?: HTMLElement | null) => {
      if (interaction == null) {
        return;
      }
      if (releaseRow.current == null) {
        releaseRow.current = interaction.pinRow('portal');
      }
      if (element != null && releasePortal.current == null) {
        releasePortal.current = interaction.registerPortal(element);
      }
    },
    [interaction],
  );

  const isHeld = useCallback(() => releaseRow.current != null, []);

  return useMemo(() => ({ acquire, release, isHeld }), [acquire, isHeld, release]);
}

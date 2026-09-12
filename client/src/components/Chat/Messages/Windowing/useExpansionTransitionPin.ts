import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useContentRowInteraction } from './contentRowInteraction';
import { CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS } from './contentRowTypes';

/**
 * The expansion-transition pin (spec §15.1, report 13 §6 Q9).
 *
 * An expanding or collapsing reasoning/summary row changes its geometry over the 300 ms
 * `grid-template-rows` transition, so it must not become a placeholder while that is in flight.
 * `begin()` is called immediately before the expansion state changes and holds the row with the
 * `animation` reason; the release happens on the expanding element's own `transitionend`, with one
 * named fallback for the case where no transition event ever arrives (a cancelled transition, a
 * background tab, a reduced-motion preference that removes the transition entirely).
 *
 * The fallback is replaced, not added, when a transition reverses — clicking twice in quick
 * succession re-arms one timer rather than stacking two. The release runs exactly once, whether it
 * comes from the transition, the fallback, or unmount.
 *
 * With no row above it (feature flag off, no provider, a subagent dialog), this is inert.
 */
export type ExpansionTransitionPin = {
  /** Acquire the pin and arm the fallback. Call before the expansion state changes. */
  begin(): void;
  /** Attach to the element that carries the `grid-template-rows` transition. */
  onTransitionEnd(event: React.TransitionEvent<HTMLElement>): void;
};

export function useExpansionTransitionPin(): ExpansionTransitionPin {
  const interaction = useContentRowInteraction();
  const releaseRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const release = useCallback(() => {
    clearTimer();
    const releaseRow = releaseRef.current;
    releaseRef.current = null;
    releaseRow?.();
  }, [clearTimer]);

  /** Unmount releases the pin and clears the timer, so nothing survives its row. */
  useEffect(() => release, [release]);

  const begin = useCallback(() => {
    if (interaction == null) {
      return;
    }
    if (releaseRef.current == null) {
      releaseRef.current = interaction.pinRow('animation');
    }
    clearTimer();
    timerRef.current = setTimeout(release, CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS);
  }, [clearTimer, interaction, release]);

  const onTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLElement>) => {
      // The expanding element owns a `grid-template-rows` transition; `opacity` rides along with
      // it and a nested transition must not release the pin on the parent's behalf.
      if (event.propertyName !== 'grid-template-rows') {
        return;
      }
      if (event.target !== event.currentTarget) {
        return;
      }
      release();
    },
    [release],
  );

  return useMemo(() => ({ begin, onTransitionEnd }), [begin, onTransitionEnd]);
}

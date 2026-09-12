import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { ContentRowInteractionProvider } from '../contentRowInteraction';
import { useExpansionTransitionPin } from '../useExpansionTransitionPin';
import { CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS } from '../contentRowTypes';
import type { ContentRowInteraction } from '../contentRowInteraction';
import type { ContentRowPinReason } from '../contentRowTypes';

/**
 * Stage 3 task 3.4 — the expansion transition pin (report 13 §6 Q9).
 *
 * The hook is exercised against a recording row, so the assertions are about the pin protocol
 * itself: acquire once, release exactly once, replace the fallback on reversal, clean up on
 * unmount, and stay inert with no row above.
 */

const pinRow = jest.fn((_reason: ContentRowPinReason) => jest.fn());

function makeRow(): ContentRowInteraction {
  return {
    pinRow,
    registerPortal: () => () => {},
    containsNode: () => false,
  };
}

const wrapper =
  (row: ContentRowInteraction | null) =>
  ({ children }: { children: React.ReactNode }) =>
    row == null ? (
      <>{children}</>
    ) : (
      <ContentRowInteractionProvider value={row}>{children}</ContentRowInteractionProvider>
    );

const transitionEnd = (overrides: { propertyName?: string; nested?: boolean } = {}) => {
  const element = document.createElement('div');
  return {
    propertyName: overrides.propertyName ?? 'grid-template-rows',
    target: overrides.nested ? document.createElement('span') : element,
    currentTarget: element,
  } as unknown as React.TransitionEvent<HTMLElement>;
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useExpansionTransitionPin', () => {
  it('acquires the animation pin before an expansion change', () => {
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    expect(pinRow).toHaveBeenCalledTimes(1);
    expect(pinRow).toHaveBeenCalledWith('animation');
  });

  it('releases the pin on the expanding element transition end', () => {
    const release = jest.fn();
    pinRow.mockReturnValueOnce(release);
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    act(() => result.current.onTransitionEnd(transitionEnd()));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases exactly once even if the transition end fires again', () => {
    const release = jest.fn();
    pinRow.mockReturnValueOnce(release);
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    act(() => result.current.onTransitionEnd(transitionEnd()));
    act(() => result.current.onTransitionEnd(transitionEnd()));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('ignores a transition end that the expanding element did not originate', () => {
    const release = jest.fn();
    pinRow.mockReturnValueOnce(release);
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    act(() => result.current.onTransitionEnd(transitionEnd({ propertyName: 'opacity' })));
    expect(release).not.toHaveBeenCalled();

    act(() => result.current.onTransitionEnd(transitionEnd({ nested: true })));
    expect(release).not.toHaveBeenCalled();

    act(() => result.current.onTransitionEnd(transitionEnd()));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('holds one pin when a transition reverses, and replaces the fallback', () => {
    const release = jest.fn();
    pinRow.mockReturnValueOnce(release);
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    act(() => jest.advanceTimersByTime(CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS - 100));
    // The user collapses again mid-transition: the pin is already held, so no second acquire.
    act(() => result.current.begin());
    expect(pinRow).toHaveBeenCalledTimes(1);

    // The replaced fallback has not elapsed yet, so the row is still pinned.
    act(() => jest.advanceTimersByTime(200));
    expect(release).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(200));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases through the named fallback when no transition event arrives', () => {
    const release = jest.fn();
    pinRow.mockReturnValueOnce(release);
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    act(() => jest.advanceTimersByTime(CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS - 1));
    expect(release).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(1));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases and clears the timer on unmount', () => {
    const release = jest.fn();
    pinRow.mockReturnValueOnce(release);
    const { result, unmount } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    unmount();
    expect(release).toHaveBeenCalledTimes(1);

    // The fallback must not fire against an unmounted hook.
    act(() => jest.advanceTimersByTime(CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS * 2));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('is inert when no row owns the subtree', () => {
    const { result } = renderHook(() => useExpansionTransitionPin(), { wrapper: wrapper(null) });

    act(() => result.current.begin());
    expect(pinRow).not.toHaveBeenCalled();

    act(() => result.current.onTransitionEnd(transitionEnd()));
    act(() => jest.advanceTimersByTime(CONTENT_ROW_TRANSITION_PIN_FALLBACK_MS * 2));
    expect(pinRow).not.toHaveBeenCalled();
  });

  it('acquires again after a released pin, so a second expansion is held too', () => {
    const first = jest.fn();
    const second = jest.fn();
    pinRow.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { result } = renderHook(() => useExpansionTransitionPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.begin());
    act(() => result.current.onTransitionEnd(transitionEnd()));
    act(() => result.current.begin());

    expect(pinRow).toHaveBeenCalledTimes(2);
    act(() => result.current.onTransitionEnd(transitionEnd()));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { ContentRowInteractionProvider } from '../contentRowInteraction';
import { useContentRowPortalPin } from '../useContentRowPortalPin';
import type { ContentRowInteraction } from '../contentRowInteraction';
import type { ContentRowPinReason } from '../contentRowTypes';

/**
 * Stage 3 task 3.5 — the portal pin protocol (report 13 §6 Q5, spec §15.2).
 *
 * Exercised against a recording row, so the assertions are the protocol: acquire pins and
 * registers, release does both once, acquire is idempotent, and unmount releases.
 */

const pinRow = jest.fn((_reason: ContentRowPinReason) => jest.fn());
const registerPortal = jest.fn((_element: HTMLElement | null) => jest.fn());
const containsNode = jest.fn(() => false);

function makeRow(): ContentRowInteraction {
  return { pinRow, registerPortal, containsNode };
}

const wrapper =
  (row: ContentRowInteraction | null) =>
  ({ children }: { children: React.ReactNode }) =>
    row == null ? (
      <>{children}</>
    ) : (
      <ContentRowInteractionProvider value={row}>{children}</ContentRowInteractionProvider>
    );

const element = () => document.createElement('div');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useContentRowPortalPin', () => {
  it('pins the row for the portal reason and registers the portaled element', () => {
    const { result } = renderHook(() => useContentRowPortalPin(), {
      wrapper: wrapper(makeRow()),
    });
    const portal = element();

    act(() => result.current.acquire(portal));
    expect(pinRow).toHaveBeenCalledTimes(1);
    expect(pinRow).toHaveBeenCalledWith('portal');
    expect(registerPortal).toHaveBeenCalledTimes(1);
    expect(registerPortal).toHaveBeenCalledWith(portal);
    expect(result.current.isHeld()).toBe(true);
  });

  it('releases the pin and the registration once', () => {
    const releaseRow = jest.fn();
    const releasePortal = jest.fn();
    pinRow.mockReturnValueOnce(releaseRow);
    registerPortal.mockReturnValueOnce(releasePortal);
    const { result } = renderHook(() => useContentRowPortalPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.acquire(element()));
    act(() => result.current.release());
    expect(releaseRow).toHaveBeenCalledTimes(1);
    expect(releasePortal).toHaveBeenCalledTimes(1);
    expect(result.current.isHeld()).toBe(false);

    act(() => result.current.release());
    expect(releaseRow).toHaveBeenCalledTimes(1);
    expect(releasePortal).toHaveBeenCalledTimes(1);
  });

  it('does not pin twice when acquire repeats while held', () => {
    const { result, rerender } = renderHook(() => useContentRowPortalPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.acquire(element()));
    rerender();
    act(() => result.current.acquire(element()));
    act(() => result.current.acquire(element()));

    expect(pinRow).toHaveBeenCalledTimes(1);
    // The element that arrived late is still registered, without a second pin.
    expect(registerPortal).toHaveBeenCalledTimes(1);
  });

  it('registers an element that arrives after the pin was acquired', () => {
    const { result } = renderHook(() => useContentRowPortalPin(), {
      wrapper: wrapper(makeRow()),
    });

    // The open state changed before the portaled element existed, which is the real order of a
    // dialog: the pin is acquired in the same commit that starts rendering the portal.
    act(() => result.current.acquire(null));
    expect(pinRow).toHaveBeenCalledTimes(1);
    expect(registerPortal).not.toHaveBeenCalled();

    const portal = element();
    act(() => result.current.acquire(portal));
    expect(pinRow).toHaveBeenCalledTimes(1);
    expect(registerPortal).toHaveBeenCalledWith(portal);
  });

  it('acquires again after a release, so a reopened dialog is held too', () => {
    const first = jest.fn();
    const second = jest.fn();
    pinRow.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { result } = renderHook(() => useContentRowPortalPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.acquire(element()));
    act(() => result.current.release());
    act(() => result.current.acquire(element()));

    expect(pinRow).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('releases on unmount, so a caller that forgets cannot pin the row forever', () => {
    const releaseRow = jest.fn();
    const releasePortal = jest.fn();
    pinRow.mockReturnValueOnce(releaseRow);
    registerPortal.mockReturnValueOnce(releasePortal);
    const { result, unmount } = renderHook(() => useContentRowPortalPin(), {
      wrapper: wrapper(makeRow()),
    });

    act(() => result.current.acquire(element()));
    unmount();
    expect(releaseRow).toHaveBeenCalledTimes(1);
    expect(releasePortal).toHaveBeenCalledTimes(1);
  });

  it('is inert when no row owns the subtree', () => {
    const { result } = renderHook(() => useContentRowPortalPin(), { wrapper: wrapper(null) });

    act(() => result.current.acquire(element()));
    expect(pinRow).not.toHaveBeenCalled();
    expect(registerPortal).not.toHaveBeenCalled();
    expect(result.current.isHeld()).toBe(false);

    act(() => result.current.release());
    expect(pinRow).not.toHaveBeenCalled();
  });
});

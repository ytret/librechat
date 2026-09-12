import { act, renderHook } from '@testing-library/react';
import useToolExpansion from '../useToolExpansion';

/**
 * Stage 3 task 3.3 — the expansion half of an individual tool.
 *
 * `useToolExpansion` is the single place that decides whether a tool toggle is controlled by the
 * lifted owner in `ContentParts` or local to this tool (report 13 §6 Q2).
 */

describe('useToolExpansion', () => {
  it('starts from the derived default and toggles locally', () => {
    const { result } = renderHook(() => useToolExpansion({ defaultExpanded: false }));

    expect(result.current.isControlled).toBe(false);
    expect(result.current.isExpanded).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.isExpanded).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isExpanded).toBe(false);
  });

  it('is uncontrolled when neither half of the controlled API is supplied', () => {
    const { result } = renderHook(() =>
      useToolExpansion({
        defaultExpanded: false,
        expansionKey: 'tool:a',
        onExpansionChange: jest.fn(),
      }),
    );

    // A key and a handler alone are not enough: the owner must supply a state value too, so
    // that an untouched tool keeps its own latched default.
    expect(result.current.isControlled).toBe(true);
    expect(result.current.isExpanded).toBe(false);
  });

  it('latches a default that becomes true, and keeps it when the default goes false again', () => {
    const { result, rerender } = renderHook(
      ({ defaultExpanded }: { defaultExpanded: boolean }) => useToolExpansion({ defaultExpanded }),
      { initialProps: { defaultExpanded: false } },
    );
    expect(result.current.isExpanded).toBe(false);

    rerender({ defaultExpanded: true });
    expect(result.current.isExpanded).toBe(true);

    rerender({ defaultExpanded: false });
    expect(result.current.isExpanded).toBe(true);
  });

  it('stays uncontrolled when only one half of the controlled API is supplied', () => {
    const onExpansionChange = jest.fn();
    const { result, rerender } = renderHook(
      ({ isExpanded }: { isExpanded: boolean }) =>
        useToolExpansion({ defaultExpanded: false, expansionKey: 'tool:a', isExpanded }),
      { initialProps: { isExpanded: false } },
    );

    rerender({ isExpanded: true });
    expect(result.current.isExpanded).toBe(false);
    expect(result.current.isControlled).toBe(false);

    const noKey = renderHook(() => useToolExpansion({ defaultExpanded: false, onExpansionChange }));
    expect(noKey.result.current.isControlled).toBe(false);
  });

  it('lets a lifted decision win over the latched default and reports changes to the owner', () => {
    const onExpansionChange = jest.fn();
    const { result, rerender } = renderHook(
      ({ isExpanded }: { isExpanded?: boolean }) =>
        useToolExpansion({
          defaultExpanded: true,
          expansionKey: 'tool:a',
          isExpanded,
          onExpansionChange,
        }),
      { initialProps: {} as { isExpanded?: boolean } },
    );
    // No recorded decision yet: the default applies.
    expect(result.current.isExpanded).toBe(true);

    rerender({ isExpanded: true });
    expect(result.current.isExpanded).toBe(true);
    // The owner says collapsed, so the latched default must not win.
    rerender({ isExpanded: false });
    expect(result.current.isExpanded).toBe(false);

    act(() => result.current.toggle());
    expect(onExpansionChange).toHaveBeenCalledWith('tool:a', true);
  });

  it('does not write local state while controlled, so a remount re-reads the owner', () => {
    const onExpansionChange = jest.fn();
    const { result, rerender } = renderHook(
      ({ isExpanded }: { isExpanded?: boolean }) =>
        useToolExpansion({
          defaultExpanded: false,
          expansionKey: 'tool:a',
          isExpanded,
          onExpansionChange,
        }),
      { initialProps: {} as { isExpanded?: boolean } },
    );

    act(() => result.current.toggle());
    expect(onExpansionChange).toHaveBeenCalledWith('tool:a', true);
    // The owner has not answered yet, so the tool is still collapsed.
    expect(result.current.isExpanded).toBe(false);

    rerender({ isExpanded: true });
    expect(result.current.isExpanded).toBe(true);
  });

  it('notifies the enclosing group only when the tool is being opened', () => {
    const onExpand = jest.fn();
    const { result } = renderHook(() => useToolExpansion({ defaultExpanded: false, onExpand }));

    act(() => result.current.toggle());
    expect(onExpand).toHaveBeenCalledTimes(1);

    act(() => result.current.toggle());
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

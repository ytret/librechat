import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render } from '@testing-library/react';
import { ContentTypes, Tools } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import ContentParts from '../ContentParts';

/**
 * Stage 3 task 3.3 — lifted expansion state for individual tools (report 13 §6 Q2).
 *
 * The tools here are real (`BashCall` → `useToolCallState` → `useToolExpansion`), so these tests
 * cover the whole path from the owner in `ContentParts` down to the toggle. Tool rows stay
 * `always-mounted` in Stage 3, so only the part-level unmount is exercised; the §20.6.2 claim
 * that an idle expanded historical tool can unmount remains deferred.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useProgress: (initial: number) => initial,
  scheduleMessageContentLayoutReconcile: jest.fn(() => jest.fn()),
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
}));

jest.mock('@librechat/client', () => ({
  Clipboard: () => <span />,
  CheckMark: () => <span />,
  Skeleton: () => <span />,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

/** The syntax highlighter is a rendering detail, not the state under test. */
jest.mock('../Parts/useLazyHighlight', () => ({
  __esModule: true,
  default: () => null,
}));

const toolCallPart = (id: string | undefined, command: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      ...(id == null ? {} : { id }),
      name: Tools.bash_tool,
      args: JSON.stringify({ command }),
      output: '',
    },
  }) as unknown as TMessageContentParts;

/** A text part renders nothing at all unless it is the last part, so it is a free spacer. */
const spacerPart = (): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text: '' }) as unknown as TMessageContentParts;

const partsTree = (content: Array<TMessageContentParts | undefined>, messageId = 'm1') => (
  <RecoilRoot>
    <ContentParts
      content={content}
      messageId={messageId}
      isCreatedByUser={false}
      isLast
      isSubmitting={false}
    />
  </RecoilRoot>
);

/** The toggle is the tool's own `ProgressText` button; the group header has an aria-label. */
const toolToggle = (container: HTMLElement, index = 0): HTMLButtonElement => {
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
  ).filter((button) => button.getAttribute('aria-label') == null);
  const button = buttons[index];
  if (!button) {
    throw new Error(`no tool toggle at index ${index}`);
  }
  return button;
};

const isToolExpanded = (container: HTMLElement, index = 0) =>
  toolToggle(container, index).getAttribute('aria-expanded');

describe('lifted tool expansion state', () => {
  it('renders a tool collapsed and expands it when its toggle is clicked', () => {
    const { container } = render(partsTree([toolCallPart('t1', 'ls -la')]));

    expect(isToolExpanded(container)).toBe('false');
    fireEvent.click(toolToggle(container));
    expect(isToolExpanded(container)).toBe('true');
  });

  it('keeps a tool expanded when its part unmounts and mounts again', () => {
    const { container, rerender } = render(partsTree([toolCallPart('t1', 'ls -la')]));
    fireEvent.click(toolToggle(container));
    expect(isToolExpanded(container)).toBe('true');

    rerender(partsTree([]));
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(0);

    rerender(partsTree([toolCallPart('t1', 'ls -la')]));
    expect(isToolExpanded(container)).toBe('true');
  });

  it('does not restore expansion onto a different tool', () => {
    const { container, rerender } = render(partsTree([toolCallPart('t1', 'ls -la')]));
    fireEvent.click(toolToggle(container));
    expect(isToolExpanded(container)).toBe('true');

    rerender(partsTree([toolCallPart('t2', 'pwd')]));
    expect(isToolExpanded(container)).toBe('false');
  });

  it('keys a tool by its id rather than by its position in the message', () => {
    const { container, rerender } = render(partsTree([spacerPart(), toolCallPart('t1', 'ls -la')]));
    fireEvent.click(toolToggle(container));
    expect(isToolExpanded(container)).toBe('true');

    // The same tool moves from index 1 to index 2; a position-keyed owner would lose it.
    rerender(partsTree([spacerPart(), spacerPart(), toolCallPart('t1', 'ls -la')]));
    expect(isToolExpanded(container)).toBe('true');
  });

  it('falls back to position for a tool call without an id', () => {
    const { container, rerender } = render(partsTree([toolCallPart(undefined, 'ls -la')]));
    fireEvent.click(toolToggle(container));
    expect(isToolExpanded(container)).toBe('true');

    rerender(partsTree([]));
    rerender(partsTree([toolCallPart(undefined, 'ls -la')]));
    expect(isToolExpanded(container)).toBe('true');
  });

  it('keeps two grouped tools independent', () => {
    const { container, rerender } = render(
      partsTree([toolCallPart('t1', 'ls -la'), toolCallPart('t2', 'pwd')]),
    );

    // Two adjacent tool calls become a group; its body renders only once the group is open.
    const groupHeader = container.querySelector<HTMLButtonElement>('button[aria-label]');
    if (!groupHeader) {
      throw new Error('expected a tool group header');
    }
    if (groupHeader.getAttribute('aria-expanded') === 'false') {
      fireEvent.click(groupHeader);
    }

    fireEvent.click(toolToggle(container, 0));
    expect(isToolExpanded(container, 0)).toBe('true');
    expect(isToolExpanded(container, 1)).toBe('false');

    rerender(partsTree([toolCallPart('t1', 'ls -la'), toolCallPart('t2', 'pwd')]));
    expect(isToolExpanded(container, 0)).toBe('true');
    expect(isToolExpanded(container, 1)).toBe('false');
  });
});

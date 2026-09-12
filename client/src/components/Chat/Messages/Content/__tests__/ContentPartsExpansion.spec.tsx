import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import { useExpandCollapse } from '~/hooks';
import ContentParts from '../ContentParts';

/**
 * Stage 3 task 3.2 — lifted reasoning and summary expansion state (report 13 §6 Q2).
 *
 * `ContentParts` owns the state, so it must outlive the unmount of the part's subtree: these
 * tests drive the real `Reasoning` and `Summary` components through their toggle buttons and
 * then remove and restore the parts while the owner stays mounted.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useExpandCollapse: jest.fn((isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  })),
  useProgress: (initial: number) => (initial >= 1 ? 1 : initial),
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

const THINK_A = {
  type: ContentTypes.THINK,
  think: 'first reasoning body',
} as TMessageContentParts;

const THINK_B = {
  type: ContentTypes.THINK,
  think: 'second reasoning body',
} as TMessageContentParts;

/** Same part as `THINK_B`, as a later stream token would deliver it. */
const THINK_B_STREAMED = {
  type: ContentTypes.THINK,
  think: 'second reasoning body, one token longer',
} as TMessageContentParts;

const SUMMARY = {
  type: ContentTypes.SUMMARY,
  content: [{ type: ContentTypes.TEXT, text: 'condensed history' }],
  model: 'gpt-4o',
  provider: 'openai',
  tokenCount: 12,
  summarizing: false,
} as TMessageContentParts;

const partsTree = (content: Array<TMessageContentParts | undefined>, messageId = 'm1') => (
  <ContentParts
    content={content}
    messageId={messageId}
    isCreatedByUser={false}
    isLast
    isSubmitting={false}
  />
);

/**
 * The header toggle of one reasoning or summary part. The floating bars render their own
 * buttons inside the same subtree, so the lookup is scoped to the part's own root element.
 */
const partToggle = (
  container: HTMLElement,
  group: 'reasoning' | 'summary',
  index = 0,
): HTMLButtonElement => {
  const root = container.querySelectorAll(`.group\\/${group}`)[index];
  const button = root?.querySelector<HTMLButtonElement>('button[aria-expanded]');
  if (!button) {
    throw new Error(`no ${group} toggle at index ${index}`);
  }
  return button;
};

const isExpanded = (container: HTMLElement, group: 'reasoning' | 'summary', index = 0) =>
  partToggle(container, group, index).getAttribute('aria-expanded');

describe('lifted expansion state', () => {
  it('renders reasoning and summary collapsed by default', () => {
    const { container } = render(partsTree([THINK_A, SUMMARY]));
    expect(isExpanded(container, 'reasoning')).toBe('false');
    expect(isExpanded(container, 'summary')).toBe('false');
  });

  it('expands reasoning when its toggle is clicked', () => {
    const { container } = render(partsTree([THINK_A]));
    fireEvent.click(partToggle(container, 'reasoning'));
    expect(isExpanded(container, 'reasoning')).toBe('true');
    fireEvent.click(partToggle(container, 'reasoning'));
    expect(isExpanded(container, 'reasoning')).toBe('false');
  });

  it('keeps reasoning expansion when its part unmounts and mounts again', () => {
    const { container, rerender } = render(partsTree([THINK_A]));
    fireEvent.click(partToggle(container, 'reasoning'));
    expect(isExpanded(container, 'reasoning')).toBe('true');

    rerender(partsTree([]));
    expect(container.querySelectorAll('.group\\/reasoning')).toHaveLength(0);

    rerender(partsTree([THINK_A]));
    expect(isExpanded(container, 'reasoning')).toBe('true');
  });

  it('keeps summary expansion when its part unmounts and mounts again', () => {
    const { container, rerender } = render(partsTree([SUMMARY]));
    fireEvent.click(partToggle(container, 'summary'));
    expect(isExpanded(container, 'summary')).toBe('true');

    rerender(partsTree([]));
    expect(container.querySelectorAll('.group\\/summary')).toHaveLength(0);

    rerender(partsTree([SUMMARY]));
    expect(isExpanded(container, 'summary')).toBe('true');
  });

  it('keeps each part independent, keyed by content-part index', () => {
    const { container, rerender } = render(partsTree([THINK_A, THINK_B]));
    fireEvent.click(partToggle(container, 'reasoning', 0));
    expect(isExpanded(container, 'reasoning', 0)).toBe('true');
    expect(isExpanded(container, 'reasoning', 1)).toBe('false');

    rerender(partsTree([THINK_A, THINK_B]));
    expect(isExpanded(container, 'reasoning', 0)).toBe('true');
    expect(isExpanded(container, 'reasoning', 1)).toBe('false');
  });

  it('scopes expansion to the message that owns the part', () => {
    const { container, rerender } = render(partsTree([THINK_A], 'm1'));
    fireEvent.click(partToggle(container, 'reasoning'));
    expect(isExpanded(container, 'reasoning')).toBe('true');

    rerender(partsTree([THINK_A], 'm2'));
    expect(isExpanded(container, 'reasoning')).toBe('false');

    rerender(partsTree([THINK_A], 'm1'));
    expect(isExpanded(container, 'reasoning')).toBe('true');
  });

  it('passes a referentially stable expansion dispatcher through the memo boundary', () => {
    const spy = useExpandCollapse as unknown as jest.Mock;
    const { rerender } = render(partsTree([THINK_A, THINK_B]));
    // `atomWithStorage` re-renders its consumers once after mount, so the count is measured
    // as a delta from the settled tree rather than as an absolute.
    const settled = spy.mock.calls.length;

    // A stream token that leaves THINK_A untouched may re-render only the part it changed:
    // exactly one of the two reasoning rows, never both.
    rerender(partsTree([THINK_A, THINK_B_STREAMED]));
    expect(spy.mock.calls.length - settled).toBe(1);
  });
});

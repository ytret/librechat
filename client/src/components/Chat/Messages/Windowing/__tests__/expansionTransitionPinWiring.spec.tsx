import React, { useMemo } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import { ContentRowInteractionProvider } from '../contentRowInteraction';
import type { ContentRowInteraction } from '../contentRowInteraction';
import type { ContentRowPinReason } from '../contentRowTypes';
import Reasoning from '../../Content/Parts/Reasoning';
import Summary from '../../Content/Parts/Summary';

/**
 * Stage 3 task 3.4 — the expansion transition pin as the reasoning and summary rows actually use
 * it (report 13 §6 Q9).
 *
 * The hook's own protocol is covered in `useExpansionTransitionPin.spec.tsx`; this file is the
 * wiring: a toggle click must acquire the pin before the expansion state changes, the pin must be
 * held through the transition, and the expanding element's own `transitionend` must release it.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
  useProgress: (initial: number) => (initial >= 1 ? 1 : initial),
  scheduleMessageContentLayoutReconcile: jest.fn(() => jest.fn()),
}));

jest.mock('~/Providers', () => ({
  useMessageContext: () => ({ isSubmitting: false, isLatestMessage: true, nextType: undefined }),
}));

jest.mock('@librechat/client', () => ({
  Clipboard: () => <span />,
  CheckMark: () => <span />,
  Skeleton: () => <span />,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
}));

/** What the pin protocol looks like from the row's side, recorded outside React. */
let recorded: { pins: ContentRowPinReason[]; releases: number };

beforeEach(() => {
  recorded = { pins: [], releases: 0 };
});

function Row({ children }: { children: React.ReactNode }) {
  const value = useMemo<ContentRowInteraction>(
    () => ({
      pinRow: (reason: ContentRowPinReason) => {
        recorded.pins.push(reason);
        return () => {
          recorded.releases += 1;
        };
      },
      registerPortal: () => () => {},
      containsNode: () => false,
    }),
    [],
  );
  return <ContentRowInteractionProvider value={value}>{children}</ContentRowInteractionProvider>;
}

const recordedPins = () => recorded.pins.join(',');
const recordedReleases = () => recorded.releases;

const THINK_BODY = 'a reasoning body';
const SUMMARY_BLOCKS = [{ type: ContentTypes.TEXT as const, text: 'a condensed history' }];

const toggle = (container: HTMLElement, group: 'reasoning' | 'summary') =>
  container
    .querySelector(`.group\\/${group}`)
    ?.querySelector<HTMLButtonElement>('button[aria-expanded]') as HTMLButtonElement;

const expandingElement = (container: HTMLElement, role: 'group' | 'region') =>
  container.querySelector(`[role="${role}"]`) as HTMLElement;

/**
 * jsdom has no `TransitionEvent`, so `fireEvent.transitionEnd` arrives without `propertyName` and
 * would be ignored by the handler for the wrong reason. Dispatching a plain event with the
 * property defined is what React's synthetic event reads.
 */
const fireTransitionEnd = (element: HTMLElement, propertyName: string) => {
  const event = new Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: propertyName });
  act(() => {
    element.dispatchEvent(event);
  });
};

describe('reasoning expansion transition pin', () => {
  it('acquires an animation pin before expanding and releases on the element transition end', () => {
    const { container } = render(
      <Row>
        <Reasoning reasoning={THINK_BODY} isLast />
      </Row>,
    );

    fireEvent.click(toggle(container, 'reasoning'));
    expect(recordedPins()).toBe('animation');
    expect(recordedReleases()).toBe(0);

    fireTransitionEnd(expandingElement(container, 'group'), 'grid-template-rows');
    expect(recordedReleases()).toBe(1);
  });

  it('holds a pin on collapse as well as on expand', () => {
    const { container } = render(
      <Row>
        <Reasoning reasoning={THINK_BODY} isLast />
      </Row>,
    );

    fireEvent.click(toggle(container, 'reasoning'));
    fireTransitionEnd(expandingElement(container, 'group'), 'grid-template-rows');
    fireEvent.click(toggle(container, 'reasoning'));

    expect(recordedPins()).toBe('animation,animation');
    fireTransitionEnd(expandingElement(container, 'group'), 'grid-template-rows');
    expect(recordedReleases()).toBe(2);
  });

  it('ignores a nested or unrelated transition end', () => {
    const { container } = render(
      <Row>
        <Reasoning reasoning={THINK_BODY} isLast />
      </Row>,
    );

    fireEvent.click(toggle(container, 'reasoning'));
    const element = expandingElement(container, 'group');
    fireTransitionEnd(element, 'opacity');
    expect(recordedReleases()).toBe(0);

    fireTransitionEnd(element.firstElementChild as HTMLElement, 'grid-template-rows');
    expect(recordedReleases()).toBe(0);

    fireTransitionEnd(element, 'grid-template-rows');
    expect(recordedReleases()).toBe(1);
  });
});

describe('summary expansion transition pin', () => {
  it('acquires an animation pin before expanding and releases on the element transition end', () => {
    const { container } = render(
      <Row>
        <Summary
          content={SUMMARY_BLOCKS}
          model="gpt-4o"
          provider="openai"
          tokenCount={3}
          summarizing={false}
        />
      </Row>,
    );

    fireEvent.click(toggle(container, 'summary'));
    expect(recordedPins()).toBe('animation');

    fireTransitionEnd(expandingElement(container, 'region'), 'grid-template-rows');
    expect(recordedReleases()).toBe(1);
  });
});

describe('with no row above', () => {
  it('expands without pinning, so an unflagged tree is unchanged', () => {
    const { container } = render(<Reasoning reasoning={THINK_BODY} isLast />);

    fireEvent.click(toggle(container, 'reasoning'));
    expect(toggle(container, 'reasoning').getAttribute('aria-expanded')).toBe('true');
    expect(recorded.pins).toHaveLength(0);
  });
});

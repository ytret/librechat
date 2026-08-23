import React, { useRef } from 'react';
import { render } from '@testing-library/react';
import useSelectionPreserve from '../useSelectionPreserve';

const TEXT = 'Hello world';
const OUTSIDE_TEXT = 'outside text';

type HarnessProps = {
  content: React.ReactNode;
  enabled?: boolean;
};

const Harness = ({ content, enabled = true }: HarnessProps) => {
  const ref = useRef<HTMLDivElement>(null);
  useSelectionPreserve(ref, enabled);
  return <div ref={ref}>{content}</div>;
};

const selectText = (container: HTMLElement, start: number, end: number) => {
  const textNode = container.querySelector('span')?.firstChild;
  if (textNode == null) {
    throw new Error('expected a text node');
  }
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

describe('useSelectionPreserve', () => {
  it('restores a selection after a re-render replaces the selected DOM nodes', () => {
    const { rerender, container } = render(<Harness content={<span key="a">{TEXT}</span>} />);

    selectText(container, 0, 5);
    expect(window.getSelection()?.toString()).toBe('Hello');

    rerender(<Harness content={<span key="b">{TEXT}</span>} />);

    expect(window.getSelection()?.toString()).toBe('Hello');
  });

  it('leaves the selection intact when the commit does not move it', () => {
    const { rerender, container } = render(<Harness content={<span>{TEXT}</span>} />);

    selectText(container, 0, 5);

    rerender(<Harness content={<span>{TEXT}</span>} />);

    expect(window.getSelection()?.toString()).toBe('Hello');
  });

  it('does not touch a selection made outside the root element', () => {
    const { rerender, container } = render(
      <>
        <span id="outside">{OUTSIDE_TEXT}</span>
        <Harness content={<span key="a">{TEXT}</span>} />
      </>,
    );

    const outside = container.querySelector('#outside');
    const textNode = outside?.firstChild;
    const range = document.createRange();
    range.setStart(textNode as Node, 0);
    range.setEnd(textNode as Node, 7);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    rerender(
      <>
        <span id="outside">{OUTSIDE_TEXT}</span>
        <Harness content={<span key="b">{TEXT}</span>} />
      </>,
    );

    expect(window.getSelection()?.toString()).toBe('outside');
  });

  it('does nothing when disabled', () => {
    const { rerender, container } = render(
      <Harness enabled={false} content={<span key="a">{TEXT}</span>} />,
    );

    selectText(container, 0, 5);

    rerender(<Harness enabled={false} content={<span key="b">{TEXT}</span>} />);

    // With preservation off, jsdom keeps the range anchored to the removed
    // node, so the selection no longer resolves to live text.
    expect(window.getSelection()?.anchorNode?.parentElement).not.toBe(
      container.querySelector('div'),
    );
  });
});

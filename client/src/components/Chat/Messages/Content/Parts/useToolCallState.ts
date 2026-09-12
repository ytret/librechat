import { useRecoilValue } from 'recoil';
import { isError } from '~/components/Chat/Messages/Content/ToolOutput';
import { useProgress, useExpandCollapse } from '~/hooks';
import useToolExpansion from './useToolExpansion';
import store from '~/store';

/** Lifted expansion wiring, supplied by `ContentParts` through `Part` (report 13 §6 Q2). */
export type ToolCallStateExpansion = {
  expansionKey?: string;
  isExpanded?: boolean;
  onExpansionChange?: (expansionKey: string, isExpanded: boolean) => void;
};

interface ToolCallState {
  showCode: boolean;
  toggleCode: () => void;
  expandStyle: React.CSSProperties;
  expandRef: React.RefObject<HTMLDivElement>;
  progress: number;
  cancelled: boolean;
  hasError: boolean;
  hasOutput: boolean;
  hasContent: boolean;
}

export default function useToolCallState(
  initialProgress: number,
  isSubmitting: boolean,
  output: string,
  hasInput: boolean,
  onExpand?: () => void,
  expansion?: ToolCallStateExpansion,
): ToolCallState {
  const autoExpand = useRecoilValue(store.autoExpandTools);
  const hasOutput = output.length > 0;
  const hasError = hasOutput && isError(output);
  const hasContent = hasInput || hasOutput;

  const { isExpanded: showCode, toggle: toggleCode } = useToolExpansion({
    defaultExpanded: autoExpand && hasContent,
    expansionKey: expansion?.expansionKey,
    isExpanded: expansion?.isExpanded,
    onExpansionChange: expansion?.onExpansionChange,
    onExpand,
  });
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(showCode);

  const progress = useProgress(initialProgress);
  const cancelled = !isSubmitting && progress < 1 && !hasError;

  return {
    showCode,
    toggleCode,
    expandStyle,
    expandRef,
    progress,
    cancelled,
    hasError,
    hasOutput,
    hasContent,
  };
}

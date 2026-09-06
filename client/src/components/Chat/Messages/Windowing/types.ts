import type { TMessage } from 'librechat-data-provider';

export type PinReason = 'latest' | 'submitting' | 'editing' | 'focus' | 'selection' | 'navigation' | 'interaction' | 'materialize';
export type RowToken = symbol;
export type RowRegistration = {
  token: RowToken;
  id: string;
  message: TMessage;
  element: HTMLElement | null;
  forceMounted: boolean;
  /** @param measuredHeight the authoritative measured height to use for the placeholder when unmounting */
  setMounted: (mounted: boolean, measuredHeight?: number) => void;
};
export type MessageWindowingContextValue = {
  registerRow: (registration: RowRegistration) => () => void;
  updateRowId: (token: RowToken, oldId: string, newId: string) => void;
  updateRowState: (token: RowToken, message: TMessage, forceMounted: boolean) => void;
  reportHeight: (token: RowToken, height: number) => void;
  isMounted: (token: RowToken) => boolean;
  pinRow: (token: RowToken, reason: PinReason) => () => void;
  ensureMessageMounted: (id: string) => Promise<HTMLElement | null>;
  materializeAll: (reason: 'screenshot' | 'find' | 'debug') => Promise<() => void>;
  notifyLayoutChange: (id: string) => void;
};

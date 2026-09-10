/**
 * Content-row windowing provider.
 *
 * Spec: `ai-reports/09-content-row-dom-windowing-spec.md`
 *   §7.2 public interface      §7.3 registry record
 *   §7.5 mount state machine   §8.1 warm-up and settlement
 *   §10 mounting policy        §11 transitions
 *   §12 measurement validation §23 diagnostics
 *
 * Stage 2 task 2.2 delivers the provider shell and the registry. Rows register,
 * update, and unregister; every newly registered row starts mounted and nothing
 * ever unmounts yet (§8.1: "All newly registered rows start mounted. They do not
 * start as estimated placeholders."). Observers, settlement, geometry passes,
 * transactions, pins, and materialization arrive in tasks 2.3–2.8.
 *
 * Mount ownership: the provider is the single owner of mount/unmount decisions and
 * of scroll correction. Rows own their own React mount state and report it through
 * `setMounted`; they never decide to unmount themselves.
 *
 * Registry data lives in refs. No mounted-row state is published through React
 * context — that rule exists because a high-frequency context value would re-render
 * the whole message list on every mount decision.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import {
  createContentRowDiagnostics,
  createLiveDiagnosticsState,
  installContentRowDiagnostics,
} from './contentRowDiagnostics';
import { computeLayoutBucket, nextGeneration } from './contentRowIdentity';
import type {
  ContentRowDiagnosticsSnapshot,
  ContentRowRecord,
  ContentRowReflowState,
  ContentRowRegistration,
  ContentRowToken,
  ContentRowUpdate,
  ContentRowWindowingRuntime,
  LayoutBucket,
  MessageScopeToken,
} from './contentRowTypes';

/** Observer mapping for a mounted content element (§7.4). */
export type MountedElementMapping = {
  token: ContentRowToken;
  generation: number;
  layoutBucket: LayoutBucket;
};

/**
 * Bucket used before a scroll root can be measured (first render, detached tree).
 * Computed from the same function as real buckets so it can never collide with a
 * real bucket by accident.
 */
export const UNKNOWN_LAYOUT_BUCKET: LayoutBucket = computeLayoutBucket({
  containerWidth: 0,
  fontSizePx: 16,
  renderingMode: 'markdown',
});

export const ContentRowWindowingContext = createContext<ContentRowWindowingRuntime | null>(null);

/**
 * Layout bucket for a scroll root (§12): container width bucket, font-size bucket,
 * and rendering mode. Null when there is no root to measure yet.
 */
export function readLayoutBucket(root: HTMLElement | null): LayoutBucket | null {
  if (!root) {
    return null;
  }
  const view = root.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? null : window);
  let fontSizePx = 16;
  if (view && typeof view.getComputedStyle === 'function') {
    const parsed = Number.parseFloat(view.getComputedStyle(root).fontSize);
    if (Number.isFinite(parsed) && parsed > 0) {
      fontSizePx = parsed;
    }
  }
  return computeLayoutBucket({
    containerWidth: root.clientWidth,
    fontSizePx,
    renderingMode: 'markdown',
  });
}

/** The `.message-render` shell that owns a row, which is what navigation resolves to. */
function messageShellOf(record: ContentRowRecord): HTMLElement | null {
  const shell =
    record.shellElement?.closest<HTMLElement>('.message-render') ??
    (typeof document === 'undefined' ? null : document.getElementById(record.messageId));
  return shell ?? null;
}

export function ContentRowWindowingProvider({
  children,
  scrollRootRef,
  conversationId,
  isDevelopment = import.meta.env.DEV,
}: {
  children: React.ReactNode;
  scrollRootRef: React.RefObject<HTMLElement>;
  conversationId?: string | null;
  /**
   * Sticky "user is pinned to the bottom" signal owned by `useMessageScrolling`.
   * Part of the provider host contract; consumed by the anchor-correction rules in
   * task 2.6. Declared here so Stage 3 can wire it once and the signature never
   * changes. Not destructured until it is used, so no dead binding exists.
   */
  pinnedToBottomRef?: React.RefObject<boolean>;
  /** Injectable so tests and production agree on diagnostics installation. */
  isDevelopment?: boolean;
}) {
  const rows = useRef(new Map<ContentRowToken, ContentRowRecord>());
  const byMessageId = useRef(new Map<string, Set<ContentRowRecord>>());
  const mountedElements = useRef(new WeakMap<Element, MountedElementMapping>());
  const diagnostics = useRef(createContentRowDiagnostics());
  const layoutBucket = useRef<LayoutBucket | null>(null);
  const reflowState = useRef<ContentRowReflowState>('idle');
  const conversationRef = useRef<string | null>(conversationId ?? null);

  const currentBucket = useCallback((): LayoutBucket => {
    const bucket = readLayoutBucket(scrollRootRef.current);
    if (bucket != null) {
      layoutBucket.current = bucket;
      return bucket;
    }
    return layoutBucket.current ?? UNKNOWN_LAYOUT_BUCKET;
  }, [scrollRootRef]);

  const indexByMessage = useCallback((record: ContentRowRecord) => {
    let set = byMessageId.current.get(record.messageId);
    if (!set) {
      set = new Set();
      byMessageId.current.set(record.messageId, set);
    }
    set.add(record);
  }, []);

  const unindexByMessage = useCallback((record: ContentRowRecord) => {
    const set = byMessageId.current.get(record.messageId);
    if (!set) {
      return;
    }
    set.delete(record);
    if (set.size === 0) {
      byMessageId.current.delete(record.messageId);
    }
  }, []);

  /**
   * Drop the measurement in hand without touching mount state. §13's opening rule:
   * an invalid measurement must never survive as a placeholder height, and §12
   * rule 6 rejects any in-flight measurement captured under the old fingerprint.
   */
  const invalidateMeasurement = useCallback((record: ContentRowRecord) => {
    record.measuredElement = null;
    record.measuredHeight = undefined;
    record.measuredFingerprint = undefined;
    record.settled = false;
    record.mountState = 'MOUNTED_UNMEASURED';
  }, []);

  /**
   * Start a new generation for a row whose source changed (§7.5). The measured
   * element is re-keyed, so the row re-measures from scratch instead of reusing a
   * height that described the previous source.
   */
  const startGeneration = useCallback((record: ContentRowRecord, fingerprint: string) => {
    record.generation = nextGeneration(record.generation);
    record.fingerprint = fingerprint;
    record.measuredFingerprint = fingerprint;
    record.measuredElement = null;
    record.measuredHeight = undefined;
    record.settled = false;
    record.pins.delete('debug');
    record.mounted = true;
    record.mountState = 'MOUNTED_UNMEASURED';
    record.setMounted(true, record.generation);
  }, []);

  const unregisterRow = useCallback(
    (record: ContentRowRecord) => {
      rows.current.delete(record.token);
      unindexByMessage(record);
      if (record.shellElement) {
        mountedElements.current.delete(record.shellElement);
      }
      // Any waiter must be released; nothing may hang on a row that no longer exists.
      record.commitWaiters.forEach((resolve) => resolve());
      record.commitWaiters.clear();
      diagnostics.current.recordUnregistration();
    },
    [unindexByMessage],
  );

  const registerRow = useCallback(
    (registration: ContentRowRegistration) => {
      if (rows.current.has(registration.token)) {
        return () => {};
      }
      const record: ContentRowRecord = {
        token: registration.token,
        scopeToken: registration.scopeToken,
        messageId: registration.messageId,
        conversationId: conversationRef.current,
        debugKey: registration.debugKey,
        kind: registration.kind,
        fingerprint: registration.fingerprint,
        measuredFingerprint: registration.fingerprint,
        policy: registration.policy,
        shellElement: registration.shellElement,
        measuredElement: null,
        // §8.1 — never an estimated placeholder on first registration.
        mounted: true,
        committedMounted: true,
        generation: 1,
        layoutBucket: currentBucket(),
        measuredHeight: undefined,
        mountState: 'MOUNTED_UNMEASURED',
        settled: false,
        forceMounted: registration.forceMounted,
        oversized: false,
        pinnedByPolicy: null,
        pins: new Set(),
        setMounted: registration.setMounted,
        commitWaiters: new Set(),
      };
      rows.current.set(record.token, record);
      indexByMessage(record);
      diagnostics.current.recordRegistration();
      return () => {
        unregisterRow(record);
      };
    },
    [currentBucket, indexByMessage, unregisterRow],
  );

  const updateRow = useCallback(
    (token: ContentRowToken, update: ContentRowUpdate) => {
      const record = rows.current.get(token);
      if (!record) {
        return;
      }
      if (update.messageId !== undefined && update.messageId !== record.messageId) {
        unindexByMessage(record);
        record.messageId = update.messageId;
        indexByMessage(record);
      }
      if (update.debugKey !== undefined) {
        record.debugKey = update.debugKey;
      }
      if (update.policy !== undefined) {
        record.policy = update.policy;
      }
      if (update.forceMounted !== undefined) {
        record.forceMounted = update.forceMounted;
      }
      if (update.fingerprint !== undefined && update.fingerprint !== record.fingerprint) {
        startGeneration(record, update.fingerprint);
      }
    },
    [indexByMessage, startGeneration, unindexByMessage],
  );

  const getLayoutBucket = useCallback(() => currentBucket(), [currentBucket]);

  /**
   * Resolve the message shell that owns a message's rows, mounting them on the way.
   *
   * Task 2.8 adds the current-generation measurement wait required by §20.7.2 and
   * the navigation timeout; here it mounts the rows and returns the shell.
   */
  const ensureMessageContentMounted = useCallback(async (messageId: string) => {
    const records = byMessageId.current.get(messageId);
    if (!records || records.size === 0) {
      return null;
    }
    let shell: HTMLElement | null = null;
    for (const record of records) {
      if (!record.mounted) {
        record.mounted = true;
        record.setMounted(true, record.generation);
      }
      shell = shell ?? messageShellOf(record);
    }
    return shell;
  }, []);

  const getDiagnostics = useCallback((): ContentRowDiagnosticsSnapshot => {
    return diagnostics.current.snapshot(
      createLiveDiagnosticsState(rows.current.values(), {
        layoutBucket: layoutBucket.current,
        reflowState: reflowState.current,
      }),
    );
  }, []);

  const value = useMemo(
    () => ({
      registerRow,
      updateRow,
      getLayoutBucket,
      ensureMessageContentMounted,
      getDiagnostics,
    }),
    [registerRow, updateRow, getLayoutBucket, ensureMessageContentMounted, getDiagnostics],
  );

  // Development-only console handle (§23). Production installs nothing.
  useEffect(() => {
    return installContentRowDiagnostics(diagnostics.current, {
      isDevelopment,
      getLive: () =>
        createLiveDiagnosticsState(rows.current.values(), {
          layoutBucket: layoutBucket.current,
          reflowState: reflowState.current,
        }),
    });
  }, [isDevelopment]);

  /**
   * A conversation change must not let a reused component position keep a height
   * measured for another conversation. Rows are invalidated, never unmounted, and
   * the comparison is per record so it cannot race with rows registering for the
   * new conversation in the same commit.
   */
  useEffect(() => {
    conversationRef.current = conversationId ?? null;
    rows.current.forEach((record) => {
      if (record.conversationId === conversationRef.current) {
        return;
      }
      record.conversationId = conversationRef.current;
      invalidateMeasurement(record);
    });
  }, [conversationId, invalidateMeasurement]);

  return (
    <ContentRowWindowingContext.Provider value={value}>
      {children}
    </ContentRowWindowingContext.Provider>
  );
}

export function useContentRowWindowing(): ContentRowWindowingRuntime {
  const context = useContext(ContentRowWindowingContext);
  if (!context) {
    throw new Error('useContentRowWindowing must be used within ContentRowWindowingProvider');
  }
  return context;
}

export function useOptionalContentRowWindowing(): ContentRowWindowingRuntime | null {
  return useContext(ContentRowWindowingContext);
}

export type { MessageScopeToken };

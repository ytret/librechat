import React from 'react';
import { isContentRowWindowingEnabled } from './contentRowFeatureFlag';
import { ContentRowWindowingProvider } from './ContentRowWindowingContext';

/**
 * Hosts content-row windowing around the chat's messages (spec §7.2, report 13 §6 Q6).
 *
 * Mounted only while the feature flag is on, which is the build default *off*, so Stage 3 changes
 * nothing about the shipped chat. The flag is read once per render and its development override is
 * applied at start-up, so toggling it is a reload either way.
 *
 * Gating the mount matters beyond cost: the provider publishes the single development diagnostics
 * handle and owns the one shared observer set, so an unflagged chat that mounted it would clobber
 * the dev fixture's handle and install observers nothing uses. With the flag off this renders its
 * children untouched — no provider, no listeners, no global.
 */
export function ContentRowWindowingHost({
  scrollRootRef,
  conversationId,
  pinnedToBottomRef,
  children,
}: {
  scrollRootRef: React.RefObject<HTMLElement>;
  conversationId?: string | null;
  /** Sticky "user is pinned to the bottom" signal owned by `useMessageScrolling`. */
  pinnedToBottomRef: React.RefObject<boolean>;
  children: React.ReactNode;
}) {
  if (!isContentRowWindowingEnabled()) {
    return <>{children}</>;
  }
  return (
    <ContentRowWindowingProvider
      scrollRootRef={scrollRootRef}
      conversationId={conversationId}
      pinnedToBottomRef={pinnedToBottomRef}
    >
      {children}
    </ContentRowWindowingProvider>
  );
}

export default ContentRowWindowingHost;

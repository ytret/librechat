import { useState, useRef, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { CSSTransition } from 'react-transition-group';
import type { TMessage } from 'librechat-data-provider';
import { useScreenshot, useMessageScrolling, useLocalize } from '~/hooks';
import ScrollToBottom from '~/components/Messages/ScrollToBottom';
import { MessagesViewProvider } from '~/Providers';
import { MessageWindowingProvider, useMessageWindowing } from './Windowing';
import { fontSizeAtom } from '~/store/fontSize';
import MultiMessage from './MultiMessage';
import MessageNav from './MessageNav';
import { cn } from '~/utils';
import store from '~/store';

function MessagesViewContent({
  messagesTree: _messagesTree,
}: {
  messagesTree?: TMessage[] | null;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const { screenshotTargetRef } = useScreenshot();
  const scrollButtonPreference = useRecoilValue(store.showScrollButton);
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);
  const scrollToBottomRef = useRef<HTMLDivElement>(null);

  const {
    conversation,
    contentRef,
    scrollableRef,
    messagesEndRef,
    showScrollButton,
    handleSmoothToRef,
    debouncedHandleScroll,
    pinnedToBottomRef,
  } = useMessageScrolling(_messagesTree);

  const { conversationId } = conversation ?? {};

  return (
    <MessageWindowingProvider
      key={conversationId ?? 'no-conversation'}
      scrollableRef={scrollableRef}
      conversationId={conversationId}
      pinnedToBottomRef={pinnedToBottomRef}
    >
      <MessagesViewBody
        messagesTree={_messagesTree}
        localize={localize}
        fontSize={fontSize}
        screenshotTargetRef={screenshotTargetRef}
        scrollButtonPreference={scrollButtonPreference}
        currentEditId={currentEditId}
        setCurrentEditId={setCurrentEditId}
        scrollToBottomRef={scrollToBottomRef}
        scrollableRef={scrollableRef}
        contentRef={contentRef}
        messagesEndRef={messagesEndRef}
        showScrollButton={showScrollButton}
        handleSmoothToRef={handleSmoothToRef}
        debouncedHandleScroll={debouncedHandleScroll}
        conversationId={conversationId}
      />
    </MessageWindowingProvider>
  );
}

type MessagesViewBodyProps = {
  messagesTree: TMessage[] | null | undefined;
  localize: ReturnType<typeof useLocalize>;
  fontSize: string;
  screenshotTargetRef: ReturnType<typeof useScreenshot>['screenshotTargetRef'];
  scrollButtonPreference: boolean;
  currentEditId: number | string | null;
  setCurrentEditId: Dispatch<SetStateAction<number | string | null>>;
  scrollToBottomRef: RefObject<HTMLDivElement>;
  scrollableRef: ReturnType<typeof useMessageScrolling>['scrollableRef'];
  contentRef: ReturnType<typeof useMessageScrolling>['contentRef'];
  messagesEndRef: ReturnType<typeof useMessageScrolling>['messagesEndRef'];
  showScrollButton: ReturnType<typeof useMessageScrolling>['showScrollButton'];
  handleSmoothToRef: ReturnType<typeof useMessageScrolling>['handleSmoothToRef'];
  debouncedHandleScroll: ReturnType<typeof useMessageScrolling>['debouncedHandleScroll'];
  conversationId?: string | null;
};

function MessagesViewBody({
  messagesTree,
  localize,
  fontSize,
  screenshotTargetRef,
  scrollButtonPreference,
  currentEditId,
  setCurrentEditId,
  scrollToBottomRef,
  scrollableRef,
  contentRef,
  messagesEndRef,
  showScrollButton,
  handleSmoothToRef,
  debouncedHandleScroll,
  conversationId,
}: MessagesViewBodyProps) {
  const { materializeAll } = useMessageWindowing();
  const { registerMaterializer } = useScreenshot();
  useEffect(
    () => registerMaterializer?.(() => materializeAll('screenshot')),
    [registerMaterializer, materializeAll],
  );
  return (
    <>
      <div className="relative flex-1 overflow-hidden overflow-y-auto">
        <div className="relative h-full">
          <div
            className="scrollbar-gutter-stable"
            onScroll={debouncedHandleScroll}
            ref={scrollableRef}
            style={{
              height: '100%',
              overflowY: 'auto',
              width: '100%',
            }}
          >
            <div ref={contentRef} className="flex flex-col pb-9 pt-14 dark:bg-transparent">
              {(messagesTree && messagesTree.length == 0) || messagesTree === null ? (
                <div
                  className={cn(
                    'flex w-full items-center justify-center p-3 text-text-secondary',
                    fontSize,
                  )}
                >
                  {localize('com_ui_nothing_found')}
                </div>
              ) : (
                <>
                  <div ref={screenshotTargetRef}>
                    <MultiMessage
                      messagesTree={messagesTree}
                      messageId={conversationId ?? null}
                      setCurrentEditId={setCurrentEditId}
                      currentEditId={currentEditId ?? null}
                    />
                  </div>
                </>
              )}
              <div
                id="messages-end"
                className="group h-0 w-full flex-shrink-0"
                ref={messagesEndRef}
              />
            </div>
          </div>

          <CSSTransition
            in={showScrollButton && scrollButtonPreference}
            timeout={{
              enter: 300,
              exit: 250,
            }}
            classNames="scroll-animation"
            unmountOnExit={true}
            appear={true}
            nodeRef={scrollToBottomRef}
          >
            <ScrollToBottom ref={scrollToBottomRef} scrollHandler={handleSmoothToRef} />
          </CSSTransition>

          <MessageNav scrollableRef={scrollableRef} />
        </div>
      </div>
    </>
  );
}

export default function MessagesView({ messagesTree }: { messagesTree?: TMessage[] | null }) {
  return (
    <MessagesViewProvider>
      <MessagesViewContent messagesTree={messagesTree} />
    </MessagesViewProvider>
  );
}

import React from 'react';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { render, screen } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import store from '~/store';
import HoverButtons from '../HoverButtons';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGenerationsByLatest: () => ({
    hideEditButton: false,
    regenerateEnabled: false,
    continueSupported: false,
    forkingSupported: true,
    isEditableEndpoint: true,
  }),
}));

jest.mock('~/components/Conversations', () => ({
  __esModule: true,
  Fork: () => <div data-testid="fork-button" />,
}));

jest.mock('../MessageAudio', () => ({
  __esModule: true,
  default: () => <div data-testid="message-audio" />,
}));

jest.mock('../Feedback', () => ({
  __esModule: true,
  default: () => <div data-testid="feedback-buttons" />,
}));

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'openAI',
} as TConversation;

const assistantMessage = {
  messageId: 'message-1',
  conversationId: conversation.conversationId,
  text: 'Hello',
  isCreatedByUser: false,
} as TMessage;

const baseProps = {
  index: 0,
  isEditing: false,
  enterEdit: jest.fn(),
  copyToClipboard: jest.fn(),
  conversation,
  isSubmitting: false,
  message: assistantMessage,
  regenerate: jest.fn(),
  handleContinue: jest.fn(),
  latestMessageId: 'message-1',
  isLast: true,
  handleFeedback: jest.fn(),
};

function renderHoverButtons(overrides?: {
  showEditButton?: boolean;
  showFeedbackButtons?: boolean;
}) {
  const initializeState = ({ set }: MutableSnapshot) => {
    if (overrides?.showEditButton !== undefined) {
      set(store.showEditButton, overrides.showEditButton);
    }
    if (overrides?.showFeedbackButtons !== undefined) {
      set(store.showFeedbackButtons, overrides.showFeedbackButtons);
    }
  };

  return render(
    <RecoilRoot initializeState={initializeState}>
      <HoverButtons {...baseProps} />
    </RecoilRoot>,
  );
}

describe('HoverButtons message action toggles', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the edit button when showEditButton is true', () => {
    renderHoverButtons({ showEditButton: true });
    expect(screen.getByTitle('com_ui_edit')).toBeInTheDocument();
  });

  it('hides the edit button when showEditButton is false', () => {
    renderHoverButtons({ showEditButton: false });
    expect(screen.queryByTitle('com_ui_edit')).toBeNull();
  });

  it('renders the feedback buttons when showFeedbackButtons is true', () => {
    renderHoverButtons({ showFeedbackButtons: true });
    expect(screen.getByTestId('feedback-buttons')).toBeInTheDocument();
  });

  it('hides the feedback buttons when showFeedbackButtons is false', () => {
    renderHoverButtons({ showFeedbackButtons: false });
    expect(screen.queryByTestId('feedback-buttons')).toBeNull();
  });

  it('renders both buttons by default for existing users', () => {
    renderHoverButtons();
    expect(screen.getByTitle('com_ui_edit')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-buttons')).toBeInTheDocument();
  });
});

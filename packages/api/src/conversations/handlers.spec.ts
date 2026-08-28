import type { Request, Response } from 'express';
import type { ConversationMetadataResponse } from 'librechat-data-provider';
import { createConversationMetadataHandler } from './handlers';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const metadata: ConversationMetadataResponse = {
  conversationId: 'convo-1',
  title: 'Test chat',
  endpoint: 'openAI',
  model: 'gpt-4o',
  modelLabel: null,
  agentId: null,
  assistantId: null,
  chatProjectId: null,
  createdAt: '2026-08-28T08:00:00.000Z',
  lastMessageAt: '2026-08-28T09:45:00.000Z',
  updatedAt: '2026-08-28T10:00:00.000Z',
  messageCount: 3,
};

describe('createConversationMetadataHandler', () => {
  let getConvoMetadata: jest.Mock;
  let getMetadata: ReturnType<typeof createConversationMetadataHandler>['getMetadata'];

  beforeEach(() => {
    getConvoMetadata = jest.fn();
    getMetadata = createConversationMetadataHandler({ getConvoMetadata }).getMetadata;
  });

  it('returns 200 with metadata for an owned conversation', async () => {
    getConvoMetadata.mockResolvedValue(metadata);

    const req = {
      params: { conversationId: 'convo-1' },
      user: { id: 'user123' },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await getMetadata(req, res);

    expect(getConvoMetadata).toHaveBeenCalledWith('user123', 'convo-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(metadata);
  });

  it('returns 400 when conversationId is missing', async () => {
    const req = { params: {}, user: { id: 'user123' } } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await getMetadata(req, res);

    expect(getConvoMetadata).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when the conversation is missing or unowned', async () => {
    getConvoMetadata.mockResolvedValue(null);

    const req = {
      params: { conversationId: 'convo-1' },
      user: { id: 'user123' },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await getMetadata(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 500 when the metadata lookup throws', async () => {
    getConvoMetadata.mockRejectedValue(new Error('boom'));

    const req = {
      params: { conversationId: 'convo-1' },
      user: { id: 'user123' },
    } as unknown as Request;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    await getMetadata(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IConversation, IMessage } from '../types';
import { createConversationMethods } from './conversation';
import { createMessageMethods } from './message';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const USER = 'user123';

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let Conversation: mongoose.Model<IConversation>;
let Message: mongoose.Model<IMessage>;
let getConvoMetadata: ReturnType<typeof createConversationMethods>['getConvoMetadata'];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();

  const models = createModels(mongoose);
  Object.assign(mongoose.models, models);
  Conversation = mongoose.models.Conversation as mongoose.Model<IConversation>;
  Message = mongoose.models.Message as mongoose.Model<IMessage>;

  const messageMethods = createMessageMethods(mongoose);
  getConvoMetadata = createConversationMethods(mongoose, messageMethods).getConvoMetadata;

  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Conversation.deleteMany({});
  await Message.deleteMany({});
});

describe('getConvoMetadata', () => {
  it('returns conversation fields enriched with message count and last message time', async () => {
    const conversationId = 'convo-1';
    await Conversation.create({
      conversationId,
      user: USER,
      endpoint: 'openAI',
      title: 'Test chat',
      model: 'gpt-4o',
      modelLabel: 'GPT-4o (work)',
    });
    await Message.create([
      {
        messageId: 'm1',
        conversationId,
        user: USER,
        text: 'a',
        isCreatedByUser: true,
        createdAt: new Date('2026-08-28T09:00:00.000Z'),
      },
      {
        messageId: 'm2',
        conversationId,
        user: USER,
        text: 'b',
        isCreatedByUser: false,
        createdAt: new Date('2026-08-28T09:30:00.000Z'),
      },
      {
        messageId: 'm3',
        conversationId,
        user: USER,
        text: 'c',
        isCreatedByUser: true,
        createdAt: new Date('2026-08-28T09:45:00.000Z'),
      },
    ]);

    const result = await getConvoMetadata(USER, conversationId);

    expect(result).not.toBeNull();
    expect(result?.conversationId).toBe(conversationId);
    expect(result?.title).toBe('Test chat');
    expect(result?.endpoint).toBe('openAI');
    expect(result?.model).toBe('gpt-4o');
    expect(result?.modelLabel).toBe('GPT-4o (work)');
    expect(result?.createdAt).toEqual(expect.any(String));
    expect(result?.updatedAt).toEqual(expect.any(String));
    expect(result?.messageCount).toBe(3);
    expect(result?.lastMessageAt).toBe('2026-08-28T09:45:00.000Z');
  });

  it('excludes messages belonging to other users from the aggregate', async () => {
    const conversationId = 'convo-2';
    await Conversation.create({ conversationId, user: USER, endpoint: 'openAI' });
    await Message.create([
      {
        messageId: 'm1',
        conversationId,
        user: USER,
        text: 'a',
        isCreatedByUser: true,
        createdAt: new Date('2026-08-28T09:00:00.000Z'),
      },
      {
        messageId: 'm2',
        conversationId,
        user: 'other-user',
        text: 'b',
        isCreatedByUser: true,
        createdAt: new Date('2026-08-28T09:30:00.000Z'),
      },
    ]);

    const result = await getConvoMetadata(USER, conversationId);

    expect(result?.messageCount).toBe(1);
    expect(result?.lastMessageAt).toBe('2026-08-28T09:00:00.000Z');
  });

  it('returns null when the conversation is not owned by the user', async () => {
    await Conversation.create({
      conversationId: 'convo-3',
      user: 'other-user',
      endpoint: 'openAI',
    });

    const result = await getConvoMetadata(USER, 'convo-3');

    expect(result).toBeNull();
  });

  it('returns a zero count and null last message time for an empty conversation', async () => {
    const conversationId = 'convo-4';
    await Conversation.create({ conversationId, user: USER, endpoint: 'openAI' });

    const result = await getConvoMetadata(USER, conversationId);

    expect(result?.messageCount).toBe(0);
    expect(result?.lastMessageAt).toBeNull();
  });
});

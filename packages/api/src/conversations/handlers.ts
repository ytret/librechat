import { logger } from '@librechat/data-schemas';
import type { ConversationMetadataResponse } from 'librechat-data-provider';
import type { Request, Response } from 'express';

interface ConversationRequest extends Request {
  user?: {
    id?: string;
    _id?: {
      toString(): string;
    };
  };
}

type ConversationMetadataDeps = {
  getConvoMetadata: (
    user: string,
    conversationId: string,
  ) => Promise<ConversationMetadataResponse | null>;
};

const getUserId = (req: ConversationRequest): string =>
  req.user?.id ?? req.user?._id?.toString() ?? '';

export function createConversationMetadataHandler(deps: ConversationMetadataDeps): {
  getMetadata: (req: ConversationRequest, res: Response) => Promise<Response>;
} {
  async function getMetadata(req: ConversationRequest, res: Response): Promise<Response> {
    const { conversationId } = req.params;

    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return res.status(400).json({ error: 'conversationId is required' });
    }

    try {
      const metadata = await deps.getConvoMetadata(getUserId(req), conversationId);
      if (!metadata) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      return res.status(200).json(metadata);
    } catch (error) {
      logger.error('[conversations] Error getting conversation metadata', error);
      return res.status(500).json({ error: 'Error getting conversation metadata' });
    }
  }

  return { getMetadata };
}

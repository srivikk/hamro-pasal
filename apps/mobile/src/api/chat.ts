import {
  chatHistoryResponseSchema,
  sanitizeChatMessage,
  type ChatMessage,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';
import { orderPath } from './orders';

export function chatHistoryPath(orderId: string): string {
  return `${orderPath(orderId)}/chat`;
}

export function chatHistoryQueryKey(orderId: string) {
  return ['chat-history', orderId] as const;
}

/**
 * GET /api/orders/:id/chat: the order's dispute transcript, oldest first, as the /chat server
 * broadcast it. The server already strips last_name and phone numbers; every message is run
 * through the same filter again here, exactly like live socket payloads.
 */
export async function fetchChatHistory(orderId: string): Promise<ChatMessage[]> {
  const { messages } = await apiRequest({
    method: 'GET',
    path: chatHistoryPath(orderId),
    schema: chatHistoryResponseSchema,
  });
  return messages.flatMap((message) => {
    const safe = sanitizeChatMessage(message);
    return safe === null ? [] : [safe];
  });
}

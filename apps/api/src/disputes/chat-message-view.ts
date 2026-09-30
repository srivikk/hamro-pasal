import {
  sanitizeChatMessage,
  type ChatMessage,
  type ChatMessageRow,
  type User,
} from '@hamro-pasal/shared-types';

/**
 * THE PRIVACY FILTER (SPEC implicit requirement 6): the one way a stored chat message becomes
 * something a client sees, used by the /chat broadcast and by GET /api/orders/:id/chat alike.
 * `sender` is the sender's full users row, last_name and phone included; `sanitizeChatMessage`
 * strips `last_name` / `phone_number` / `phone` at every depth and reduces the result to the
 * allowlisted chat contract (sender = id, first name, role).
 */
export function publicChatMessage(row: ChatMessageRow, orderId: string, sender: User): ChatMessage {
  const message = sanitizeChatMessage({
    id: row.id,
    client_id: row.client_id,
    order_id: orderId,
    sender,
    body: row.body,
    attachments: row.attachments,
    sent_at: row.created_at.toISOString(),
  });
  if (message === null) throw new Error(`Chat message ${row.id} broke the chat contract`);
  return message;
}

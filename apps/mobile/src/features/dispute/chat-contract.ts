import {
  chatMessageSchema,
  sanitizeChatMessage,
  type ChatAttachment,
  type ChatMessage,
} from '@hamro-pasal/shared-types';

/*
 * Dispute chat wire format for the Socket.io `/chat` namespace. The contract lives in
 * @hamro-pasal/shared-types (realtime/chat-socket.ts) and the API applies it before broadcasting.
 *
 * PRIVACY (SPEC implicit requirement 6): the server strips last_name and phone_number from every
 * user object it broadcasts. The app does not rely on that: every incoming payload goes through the
 * same filter again (PII keys removed at every depth, users reduced to id, first name and role), and
 * outgoing messages carry no user object at all.
 */

export {
  chatAttachmentSchema,
  chatMessageSchema,
  chatUserSchema,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_MESSAGE_LENGTH,
  sanitizeChatUser,
  type ChatAttachment,
  type ChatMessage,
  type ChatUser,
} from '@hamro-pasal/shared-types';

/**
 * Incoming `chat:new_message` payload: reduced to the allowlisted shape (sender included), or
 * null when it does not match the contract, in which case it is never rendered.
 */
export function sanitizeIncomingMessage(payload: unknown): ChatMessage | null {
  return sanitizeChatMessage(payload);
}

export interface OutgoingMessageInput {
  clientId: string;
  orderId: string;
  /** Whatever profile object the app holds; only the allowlisted fields are kept locally. */
  sender: unknown;
  body: string;
  attachments: readonly ChatAttachment[];
  sentAt: Date;
}

/**
 * The local copy of a message being sent (shown as "Sending…" until the server's version replaces
 * it). Throws if the result breaks the contract.
 */
export function buildOutgoingMessage(input: OutgoingMessageInput): ChatMessage {
  const message = sanitizeChatMessage({
    id: input.clientId,
    client_id: input.clientId,
    order_id: input.orderId,
    sender: input.sender,
    body: input.body.trim(),
    attachments: input.attachments,
    sent_at: input.sentAt.toISOString(),
  });
  // Re-parse for the precise contract error when sanitizing fails.
  return message ?? chatMessageSchema.parse(input);
}

/**
 * What is emitted as `chat:new_message`: the server reads only these fields and sets the id, time
 * and sender itself, so no user data leaves the device with a message.
 */
export interface ChatSendPayload {
  client_id: string;
  order_id: string;
  body: string;
  attachments: ChatAttachment[];
}

export function toSendPayload(message: ChatMessage): ChatSendPayload {
  return {
    client_id: message.client_id ?? message.id,
    order_id: message.order_id,
    body: message.body,
    attachments: message.attachments.map(({ url, content_type }) => ({ url, content_type })),
  };
}

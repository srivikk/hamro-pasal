import { z } from 'zod';

import { userRoleSchema } from '../domain/enums';

/*
 * Socket.io `/chat` namespace: the dispute chat of a delivered order (SPEC customer journey 11,
 * implicit requirement 4: event `chat:new_message`). The API serves the namespace behind the same
 * Redis adapter as `/orders`, so a message reaches every participant on every API instance.
 *
 * PRIVACY (SPEC implicit requirement 6): the server builds every broadcast from its own user rows
 * and runs it through `sanitizeChatMessage` before emitting it. User objects are reduced to an
 * ALLOWLIST (id, first name, role), and the PII keys below are removed at every depth first, so
 * `last_name` and `phone_number` can never reach the other party, whatever the caller passed in.
 * The mobile app applies the same filter to everything it receives, but never relies on it.
 */

export const CHAT_NAMESPACE = '/chat';

export const CHAT_SOCKET_EVENTS = {
  /** Client → server, with ack: join the dispute room of an order the caller takes part in. */
  join: 'chat:join',
  /** Client → server with ack (a message to send); server → room (the sanitized broadcast). */
  newMessage: 'chat:new_message',
} as const;

/** The room every message of one order's dispute is broadcast to. */
export function disputeRoom(orderId: string): string {
  return `dispute:${orderId}`;
}

export const MAX_CHAT_MESSAGE_LENGTH = 2000;
export const MAX_CHAT_ATTACHMENTS = 4;

/** Keys that must never appear anywhere in a broadcast payload. */
export const CHAT_PII_KEYS: readonly string[] = ['last_name', 'phone_number', 'phone'];

/** The only user fields the chat ever carries. `z.object` drops every other key. */
export const chatUserSchema = z.object({
  id: z.string().min(1),
  /** First name only ("Aarav"); null when the user has none on record. */
  first_name: z.string().trim().min(1).max(60).nullable().catch(null),
  role: userRoleSchema,
});
export type ChatUser = z.infer<typeof chatUserSchema>;

export const chatAttachmentSchema = z.object({
  /**
   * Public URL of an evidence image returned by POST /api/uploads/dispute-evidence (Cloudflare R2
   * behind the CDN in production, the API's local /uploads in development, hence http too).
   */
  url: z.url({ protocol: /^https?$/ }),
  content_type: z.string().regex(/^image\/[a-z0-9.+-]+$/),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

/** A chat message as broadcast to the room (and echoed to its sender). */
export const chatMessageSchema = z.object({
  id: z.string().min(1),
  /** The sending device's own id for the message, echoed back so it can match its copy. */
  client_id: z.string().min(1).nullable(),
  order_id: z.string().min(1),
  sender: chatUserSchema,
  body: z.string().max(MAX_CHAT_MESSAGE_LENGTH),
  attachments: z.array(chatAttachmentSchema).max(MAX_CHAT_ATTACHMENTS),
  sent_at: z.iso.datetime(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** `chat:join { order_id }`. */
export const chatJoinRequestSchema = z.strictObject({ order_id: z.uuid() });
export type ChatJoinRequest = z.infer<typeof chatJoinRequestSchema>;

export const chatErrorCodes = [
  'VALIDATION_FAILED',
  'ORDER_NOT_FOUND',
  'DISPUTE_WINDOW_CLOSED',
  'INTERNAL_SERVER_ERROR',
] as const;
const chatErrorSchema = z.strictObject({
  code: z.enum(chatErrorCodes),
  message: z.string(),
});
export type ChatError = z.infer<typeof chatErrorSchema>;

export const chatJoinAckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), order_id: z.uuid() }),
  z.strictObject({ ok: z.literal(false), error: chatErrorSchema }),
]);
export type ChatJoinAck = z.infer<typeof chatJoinAckSchema>;

/**
 * What the server reads from an incoming `chat:new_message`. Anything else the client sends (its
 * idea of the sender, an id, a timestamp) is dropped: the server sets those itself.
 */
export const chatSendRequestSchema = z
  .object({
    client_id: z.string().min(1).max(100),
    order_id: z.uuid(),
    body: z.string().trim().max(MAX_CHAT_MESSAGE_LENGTH),
    attachments: z.array(chatAttachmentSchema).max(MAX_CHAT_ATTACHMENTS).default([]),
  })
  .refine((message) => message.body !== '' || message.attachments.length > 0, {
    message: 'A message needs text or an image',
  });
export type ChatSendRequest = z.output<typeof chatSendRequestSchema>;

export const chatSendAckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), message: chatMessageSchema }),
  z.strictObject({ ok: z.literal(false), error: chatErrorSchema }),
]);
export type ChatSendAck = z.infer<typeof chatSendAckSchema>;

/**
 * A copy of `value` with every PII key (CHAT_PII_KEYS) removed at every depth. The input is never
 * mutated.
 */
export function stripChatPii(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripChatPii);
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!CHAT_PII_KEYS.includes(key)) copy[key] = stripChatPii(entry);
  }
  return copy;
}

/** A user object reduced to the allowlist, or null if it lacks the required fields. */
export function sanitizeChatUser(user: unknown): ChatUser | null {
  const parsed = chatUserSchema.safeParse(stripChatPii(user));
  return parsed.success ? parsed.data : null;
}

/**
 * The privacy filter every chat payload passes through: PII keys stripped at every depth, then
 * reduced to the allowlisted message shape. Null when the payload breaks the contract (it is then
 * neither broadcast nor rendered).
 */
export function sanitizeChatMessage(payload: unknown): ChatMessage | null {
  const parsed = chatMessageSchema.safeParse(stripChatPii(payload));
  return parsed.success ? parsed.data : null;
}

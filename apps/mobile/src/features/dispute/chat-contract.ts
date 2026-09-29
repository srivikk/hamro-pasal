import { userRoleSchema } from '@hamro-pasal/shared-types';
import { z } from 'zod';

/*
 * Dispute chat wire format for the Socket.io `/chat` namespace (SPEC implicit requirement 4:
 * event `chat:new_message`). The backend has no chat server yet, so the contract lives in the app
 * until it moves to @hamro-pasal/shared-types.
 *
 * PRIVACY (SPEC implicit requirement 6): user objects are reduced to an ALLOWLIST (id, first name,
 * role). `z.object` drops every other key, so last_name, phone_number / phone, email or any field
 * added later can never reach a message bubble or an outgoing event. Every payload in either
 * direction passes through these schemas.
 */

export const MAX_CHAT_MESSAGE_LENGTH = 2000;
export const MAX_CHAT_ATTACHMENTS = 4;

/** The only user fields the chat ever carries. Everything else is stripped. */
export const chatUserSchema = z.object({
  id: z.string().min(1),
  /** First name only ("Aarav"); null when the sender has none on record. */
  first_name: z.string().trim().min(1).max(60).nullable().catch(null),
  role: userRoleSchema,
});
export type ChatUser = z.infer<typeof chatUserSchema>;

export const chatAttachmentSchema = z.object({
  /** Public URL of the evidence image in Cloudflare R2 (served through the CDN). */
  url: z.url({ protocol: /^https$/ }),
  content_type: z.string().regex(/^image\/[a-z0-9.+-]+$/),
});
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  /** Client-generated id of the sending device, echoed back so the sender can match its copy. */
  client_id: z.string().min(1).nullable(),
  order_id: z.string().min(1),
  sender: chatUserSchema,
  body: z.string().max(MAX_CHAT_MESSAGE_LENGTH),
  attachments: z.array(chatAttachmentSchema).max(MAX_CHAT_ATTACHMENTS),
  sent_at: z.iso.datetime(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** A user object reduced to the allowlist, or null if it lacks the required fields. */
export function sanitizeChatUser(user: unknown): ChatUser | null {
  const parsed = chatUserSchema.safeParse(user);
  return parsed.success ? parsed.data : null;
}

/**
 * Incoming `chat:new_message` payload: reduced to the allowlisted shape (sender included), or
 * null when it does not match the contract, in which case it is never rendered.
 */
export function sanitizeIncomingMessage(payload: unknown): ChatMessage | null {
  const parsed = chatMessageSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export interface OutgoingMessageInput {
  clientId: string;
  orderId: string;
  /** Whatever profile object the app holds; only the allowlisted fields are sent. */
  sender: unknown;
  body: string;
  attachments: readonly ChatAttachment[];
  sentAt: Date;
}

/** Builds the outgoing `chat:new_message` payload. Throws if the result breaks the contract. */
export function buildOutgoingMessage(input: OutgoingMessageInput): ChatMessage {
  return chatMessageSchema.parse({
    id: input.clientId,
    client_id: input.clientId,
    order_id: input.orderId,
    sender: input.sender,
    body: input.body.trim(),
    attachments: input.attachments,
    sent_at: input.sentAt.toISOString(),
  });
}

import {
  CHAT_SOCKET_EVENTS,
  chatJoinRequestSchema,
  chatSendRequestSchema,
  disputeRoom,
  sanitizeChatMessage,
  type ChatJoinAck,
  type ChatMessage,
  type ChatSendAck,
  type User,
  type UserRole,
} from '@hamro-pasal/shared-types';
import type { Namespace } from 'socket.io';

import type { DisputeAccess, DisputeService } from '../disputes/dispute-service';
import type { EvidenceStorage } from '../uploads/evidence-storage';
import { socketAuth, type AuthenticatedSocketData } from './socket-auth';

export interface ChatServerToClientEvents {
  'chat:new_message': (message: ChatMessage) => void;
}

/** Payloads are `unknown` on arrival: every one is validated before use. */
export interface ChatClientToServerEvents {
  'chat:join': (payload: unknown, ack?: unknown) => void;
  'chat:new_message': (payload: unknown, ack?: unknown) => void;
}

export type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  Record<string, never>,
  AuthenticatedSocketData
>;

export interface ChatNamespaceOptions {
  readonly accessTokenSecret: string;
  readonly disputes: Pick<DisputeService, 'access' | 'participantProfile' | 'recordMessage'>;
  readonly evidence: Pick<EvidenceStorage, 'isEvidenceUrl'>;
}

/** Customers, the order's vendor and Super Admins (arbitration) take part in dispute chats. */
const CHAT_ROLES: readonly UserRole[] = ['CUSTOMER', 'VENDOR', 'SUPER_ADMIN'];

/**
 * THE PRIVACY FILTER (SPEC implicit requirement 6), and the only way a message leaves the server.
 * `raw.sender` is the sender's full users row, last_name and phone included; `sanitizeChatMessage`
 * strips `last_name` / `phone_number` / `phone` at every depth and reduces the payload to the
 * allowlisted chat contract before it is broadcast. Nothing the client sent is trusted for it.
 */
export function broadcastChatMessage(namespace: ChatNamespace, raw: unknown): ChatMessage {
  const message = sanitizeChatMessage(raw);
  if (message === null) throw new Error('Chat message broke the chat contract; not broadcast');
  namespace.to(disputeRoom(message.order_id)).emit(CHAT_SOCKET_EVENTS.newMessage, message);
  return message;
}

/** Stands in for a missing ack function (acks are optional on /chat). */
const noReply = (): void => undefined;

const ACCESS_ERRORS = {
  ORDER_NOT_FOUND: 'Order not found',
  DISPUTE_WINDOW_CLOSED: 'The dispute window for this order is closed',
} as const;

/**
 * Serves the `/chat` namespace (dispute chat, SPEC customer journey 11):
 *   - handshake: the same access-token check as `/orders` (UNAUTHENTICATED / FORBIDDEN);
 *   - `chat:join { order_id }` (ack optional): joins `dispute:{order_id}` if the caller is the
 *     order's customer or vendor inside the 48 h window after delivery, or a Super Admin;
 *   - `chat:new_message { client_id, order_id, body, attachments }` (ack): the same access rule;
 *     attachments must be evidence uploaded for that order. The message is first PERSISTED
 *     (chat_messages; the order's first message also opens its disputes row), then broadcast with
 *     the stored id and time and the sender from the server's own users row (privacy-filtered),
 *     and acked `{ ok: true, message }` with exactly what was broadcast. If storing fails, nothing
 *     is broadcast. A retried send (same client_id) is stored once and re-broadcast with the same id,
 *     which clients deduplicate.
 */
export function serveChatNamespace(chat: ChatNamespace, options: ChatNamespaceOptions): void {
  chat.use(
    socketAuth(
      options.accessTokenSecret,
      CHAT_ROLES,
      'Dispute chat is not available for your role',
    ),
  );

  chat.on('connection', (socket) => {
    const participant = { userId: socket.data.userId, role: socket.data.role };
    // Per connection: the access decision per order, and the sender's profile, looked up once.
    const accessByOrder = new Map<string, Promise<DisputeAccess>>();
    let profile: Promise<User | null> | null = null;

    const accessTo = (orderId: string): Promise<DisputeAccess> => {
      let access = accessByOrder.get(orderId);
      if (access === undefined) {
        access = options.disputes.access(participant, orderId);
        accessByOrder.set(orderId, access);
        access.catch(() => accessByOrder.delete(orderId)); // a failed lookup is retried next time
      }
      return access;
    };

    socket.on(CHAT_SOCKET_EVENTS.join, (payload, ack) => {
      const reply = (typeof ack === 'function' ? ack : noReply) as (response: ChatJoinAck) => void;
      const request = chatJoinRequestSchema.safeParse(payload);
      if (!request.success) {
        reply({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'order_id is required' } });
        return;
      }
      const orderId = request.data.order_id;
      accessTo(orderId).then(
        async (access) => {
          if (!access.ok) {
            reply({ ok: false, error: { code: access.code, message: ACCESS_ERRORS[access.code] } });
            return;
          }
          await socket.join(disputeRoom(orderId));
          reply({ ok: true, order_id: orderId });
        },
        (error: unknown) => {
          console.error('[api] chat:join failed', error);
          reply({
            ok: false,
            error: { code: 'INTERNAL_SERVER_ERROR', message: 'Please try again' },
          });
        },
      );
    });

    socket.on(CHAT_SOCKET_EVENTS.newMessage, (payload, ack) => {
      const reply = (typeof ack === 'function' ? ack : noReply) as (response: ChatSendAck) => void;
      const request = chatSendRequestSchema.safeParse(payload);
      if (!request.success) {
        reply({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid chat message' } });
        return;
      }
      const { client_id: clientId, order_id: orderId, body, attachments } = request.data;

      const deliver = async (): Promise<ChatSendAck> => {
        const access = await accessTo(orderId);
        if (!access.ok) {
          return { ok: false, error: { code: access.code, message: ACCESS_ERRORS[access.code] } };
        }
        if (
          !attachments.every((attachment) =>
            options.evidence.isEvidenceUrl(orderId, attachment.url),
          )
        ) {
          return {
            ok: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Attachments must be uploaded with POST /api/uploads/dispute-evidence',
            },
          };
        }
        profile ??= options.disputes.participantProfile(participant.userId);
        const sender = await profile;
        if (sender === null) {
          profile = null;
          return { ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'Unknown sender' } };
        }
        // The transcript is written before anyone sees the message.
        const { message: stored } = await options.disputes.recordMessage({
          orderId,
          senderUserId: participant.userId,
          clientId,
          body,
          attachments,
        });
        const message = broadcastChatMessage(chat, {
          id: stored.id,
          client_id: stored.client_id,
          order_id: orderId,
          sender, // the full users row: the privacy filter in broadcastChatMessage reduces it
          body: stored.body,
          attachments: stored.attachments,
          sent_at: stored.created_at.toISOString(),
        });
        return { ok: true, message };
      };

      deliver().then(reply, (error: unknown) => {
        profile = null;
        console.error('[api] chat:new_message failed', error);
        reply({ ok: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Please try again' } });
      });
    });
  });
}

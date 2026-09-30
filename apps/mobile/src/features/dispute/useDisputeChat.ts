import { chatJoinAckSchema, chatSendAckSchema, userRoleSchema } from '@hamro-pasal/shared-types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CHAT_ACK_TIMEOUT_MS,
  CHAT_EVENTS,
  createChatSocket,
  reconnectDelayMs,
  type ChatSocket,
  type SocketFactory,
} from '../../services/socket';
import { useAuthStore } from '../../store/useAuthStore';
import {
  buildOutgoingMessage,
  sanitizeIncomingMessage,
  toSendPayload,
  type ChatAttachment,
  type ChatMessage,
  type ChatUser,
} from './chat-contract';

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'received';

export interface ThreadMessage {
  message: ChatMessage;
  mine: boolean;
  status: MessageStatus;
}

export type ChatConnection = 'connecting' | 'connected' | 'reconnecting';

/** Why the server refused to let this user into the order's dispute (final: never retried). */
export type ChatUnavailable = 'DISPUTE_WINDOW_CLOSED' | 'ORDER_NOT_FOUND';

/**
 * The signed-in user as the chat knows them: id and role from the access token's claims. The
 * token carries no name, so first_name is null (own messages are labelled "You" anyway). The
 * signature is not checked here; the server authenticates the socket with the same token.
 */
export function chatUserFromToken(token: string | null): ChatUser {
  const fallback: ChatUser = { id: 'self', first_name: null, role: 'CUSTOMER' };
  const payload = token?.split('.')[1];
  if (payload === undefined) return fallback;
  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof json !== 'object' || json === null) return fallback;
    const sub: unknown = Reflect.get(json, 'sub');
    const role = userRoleSchema.safeParse(Reflect.get(json, 'role'));
    return {
      id: typeof sub === 'string' && sub !== '' ? sub : fallback.id,
      first_name: null,
      role: role.success ? role.data : fallback.role,
    };
  } catch {
    return fallback;
  }
}

/** Adds or reconciles a message: the server's copy of our own message replaces the local one. */
function upsert(
  thread: readonly ThreadMessage[],
  incoming: ChatMessage,
  selfId: string,
): ThreadMessage[] {
  const ownIndex =
    incoming.client_id === null
      ? -1
      : thread.findIndex((entry) => entry.mine && entry.message.client_id === incoming.client_id);
  if (ownIndex !== -1) {
    return thread.map((entry, index) =>
      index === ownIndex ? { message: incoming, mine: true, status: 'sent' } : entry,
    );
  }
  if (thread.some((entry) => entry.message.id === incoming.id)) return [...thread];
  return [
    ...thread,
    { message: incoming, mine: incoming.sender.id === selfId, status: 'received' },
  ];
}

/**
 * Live dispute thread for an order over the Socket.io `/chat` namespace:
 *   - joins `chat:join { order_id }` on every (re)connect; a timed-out or INTERNAL_SERVER_ERROR ack
 *     is retried on the backoff schedule, a refusal (window closed, not your order) is final;
 *   - a sent message is "Sending…" until the server's ack, which carries the message exactly as it
 *     was broadcast (server id, time and privacy-filtered sender) and replaces the local copy;
 *   - every incoming payload goes through the chat contract's privacy filter.
 */
export function useDisputeChat(orderId: string, socketFactory?: SocketFactory) {
  const token = useAuthStore((state) => state.accessToken);
  const self = useMemo(() => chatUserFromToken(token), [token]);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [connection, setConnection] = useState<ChatConnection>('connecting');
  const [unavailable, setUnavailable] = useState<ChatUnavailable | null>(null);
  const socketRef = useRef<ChatSocket | null>(null);
  const selfIdRef = useRef(self.id);

  useEffect(() => {
    selfIdRef.current = self.id;
  }, [self.id]);

  useEffect(() => {
    const { socket, close } = createChatSocket(socketFactory);
    socketRef.current = socket;
    let joinAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const join = (): void => {
      socket
        .timeout(CHAT_ACK_TIMEOUT_MS)
        .emit(CHAT_EVENTS.join, { order_id: orderId }, (error, response) => {
          const ack = error instanceof Error ? null : chatJoinAckSchema.safeParse(response);
          if (ack?.success === true && ack.data.ok) {
            joinAttempt = 0;
            return;
          }
          if (ack?.success === true && !ack.data.ok) {
            const { code } = ack.data.error;
            if (code === 'DISPUTE_WINDOW_CLOSED' || code === 'ORDER_NOT_FOUND') {
              setUnavailable(code);
              return;
            }
            if (code === 'VALIDATION_FAILED') return; // resending the same request cannot help
          }
          if (!socket.connected) return; // the next connect joins again
          retryTimer = setTimeout(join, reconnectDelayMs(joinAttempt));
          joinAttempt += 1;
        });
    };

    const onConnect = (): void => {
      setConnection('connected');
      // Rooms are per connection: join again after every reconnection.
      if (retryTimer !== null) clearTimeout(retryTimer);
      joinAttempt = 0;
      join();
    };
    const onDisconnect = (): void => {
      setConnection('reconnecting');
    };
    const onMessage = (payload: unknown): void => {
      const message = sanitizeIncomingMessage(payload);
      if (message?.order_id !== orderId) return;
      setThread((current) => upsert(current, message, selfIdRef.current));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on(CHAT_EVENTS.newMessage, onMessage);
    socket.connect();

    return () => {
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(CHAT_EVENTS.newMessage, onMessage);
      close();
      socketRef.current = null;
    };
  }, [orderId, socketFactory]);

  const markFailed = useCallback((clientId: string) => {
    setThread((current) =>
      current.map((entry) =>
        entry.mine && entry.message.client_id === clientId && entry.status !== 'sent'
          ? { ...entry, status: 'failed' }
          : entry,
      ),
    );
  }, []);

  const emit = useCallback(
    (message: ChatMessage) => {
      const clientId = message.client_id ?? message.id;
      const socket = socketRef.current;
      if (socket === null) {
        markFailed(clientId);
        return;
      }
      // Socket.io buffers emits while disconnected and flushes them on reconnection.
      socket
        .timeout(CHAT_ACK_TIMEOUT_MS)
        .emit(CHAT_EVENTS.newMessage, toSendPayload(message), (error, response) => {
          const ack = error instanceof Error ? null : chatSendAckSchema.safeParse(response);
          const sent = ack?.success === true && ack.data.ok ? ack.data.message : null;
          // Run the server's copy through the privacy filter like any incoming payload.
          const accepted = sent === null ? null : sanitizeIncomingMessage(sent);
          if (accepted === null) {
            markFailed(clientId);
            return;
          }
          setThread((current) => upsert(current, accepted, selfIdRef.current));
        });
    },
    [markFailed],
  );

  /** Sends a message; returns false (sending nothing) when there is neither text nor an image. */
  const send = useCallback(
    (body: string, attachments: readonly ChatAttachment[] = []): boolean => {
      if (body.trim() === '' && attachments.length === 0) return false;
      const clientId = randomUUID();
      const message = buildOutgoingMessage({
        clientId,
        orderId,
        sender: self,
        body,
        attachments,
        sentAt: new Date(),
      });
      setThread((current) => [...current, { message, mine: true, status: 'sending' }]);
      emit(message);
      return true;
    },
    [emit, orderId, self],
  );

  const retry = useCallback(
    (clientId: string) => {
      const entry = thread.find((item) => item.mine && item.message.client_id === clientId);
      if (entry === undefined) return;
      setThread((current) =>
        current.map((item) =>
          item.mine && item.message.client_id === clientId ? { ...item, status: 'sending' } : item,
        ),
      );
      emit(entry.message);
    },
    [emit, thread],
  );

  return { thread, connection, unavailable, send, retry, self };
}

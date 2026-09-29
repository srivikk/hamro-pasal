import { userRoleSchema } from '@hamro-pasal/shared-types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CHAT_ACK_TIMEOUT_MS,
  CHAT_EVENTS,
  createChatSocket,
  type ChatSocket,
  type SocketFactory,
} from '../../services/socket';
import { useAuthStore } from '../../store/useAuthStore';
import {
  buildOutgoingMessage,
  sanitizeIncomingMessage,
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

/** Adds or reconciles a message: the server's echo of our own message replaces the local copy. */
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
 * Live dispute thread for an order over the Socket.io `/chat` namespace. Every incoming payload
 * and every outgoing message goes through the chat contract's privacy allowlist.
 */
export function useDisputeChat(orderId: string, socketFactory?: SocketFactory) {
  const token = useAuthStore((state) => state.accessToken);
  const self = useMemo(() => chatUserFromToken(token), [token]);
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [connection, setConnection] = useState<ChatConnection>('connecting');
  const socketRef = useRef<ChatSocket | null>(null);
  const selfIdRef = useRef(self.id);

  useEffect(() => {
    selfIdRef.current = self.id;
  }, [self.id]);

  useEffect(() => {
    const socket = createChatSocket(socketFactory);
    socketRef.current = socket;

    const onConnect = (): void => {
      setConnection('connected');
      // Rooms are per connection: join again after every reconnection.
      socket.emit(CHAT_EVENTS.join, { order_id: orderId });
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
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off(CHAT_EVENTS.newMessage, onMessage);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [orderId, socketFactory]);

  const setStatus = useCallback((clientId: string, status: MessageStatus) => {
    setThread((current) =>
      current.map((entry) =>
        entry.mine && entry.message.client_id === clientId && entry.status !== 'sent'
          ? { ...entry, status }
          : entry,
      ),
    );
  }, []);

  const emit = useCallback(
    (message: ChatMessage) => {
      const clientId = message.client_id ?? message.id;
      const socket = socketRef.current;
      if (socket === null) {
        setStatus(clientId, 'failed');
        return;
      }
      // Socket.io buffers emits while disconnected and flushes them on reconnection.
      socket
        .timeout(CHAT_ACK_TIMEOUT_MS)
        .emit(CHAT_EVENTS.newMessage, message, (error: Error | null) => {
          setStatus(clientId, error === null ? 'sent' : 'failed');
        });
    },
    [setStatus],
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
      setStatus(clientId, 'sending');
      emit(entry.message);
    },
    [emit, setStatus, thread],
  );

  return { thread, connection, send, retry, self };
}

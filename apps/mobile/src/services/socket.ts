import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

import { API_URL } from '../config/api';
import type { ChatMessage } from '../features/dispute/chat-contract';
import { useAuthStore } from '../store/useAuthStore';

/*
 * Socket.io client (SPEC implicit requirement 4 and infrastructure §1). Discrete namespaces:
 * `/orders` for state updates, `/chat` for dispute chat. The backend does not serve Socket.io yet,
 * so this is the client half, ready for it.
 */

export const CHAT_NAMESPACE = '/chat';

export const CHAT_EVENTS = {
  /** Client → server: join the dispute room of an order. */
  join: 'chat:join',
  /** Both directions: one chat message (see features/dispute/chat-contract.ts). */
  newMessage: 'chat:new_message',
} as const;

/** Events the server emits. Payloads are `unknown` until the privacy/contract filter has run. */
export interface ChatServerToClientEvents {
  'chat:new_message': (payload: unknown) => void;
}

/** Events the app emits. Messages are always built by buildOutgoingMessage (sanitized). */
export interface ChatClientToServerEvents {
  'chat:join': (payload: { order_id: string }) => void;
  'chat:new_message': (payload: ChatMessage, ack: (response: unknown) => void) => void;
}

export type ChatSocket = Socket<ChatServerToClientEvents, ChatClientToServerEvents>;

/** Reconnection backoff: 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s (SPEC: flaky mobile networks). */
export const RECONNECT_DELAY_MS = 1000;
export const RECONNECT_DELAY_MAX_MS = 30_000;
const RECONNECT_FACTOR = 2;

/**
 * Heartbeat interval (SPEC: 25 s). In Socket.io the ping/pong heartbeat is driven by the SERVER:
 * its `pingInterval` (25 000 ms, also the Socket.io default) is sent in the handshake and the
 * client follows it, closing and reconnecting when a ping is overdue. A client cannot set it, so
 * this constant is the value the `/chat` server must be configured with.
 */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** Server acknowledgement deadline for an emitted chat message. */
export const CHAT_ACK_TIMEOUT_MS = 10_000;

/** The delay before reconnection attempt `attempt` (0-based), exactly as the client schedules it. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_DELAY_MS * RECONNECT_FACTOR ** attempt, RECONNECT_DELAY_MAX_MS);
}

export function chatSocketOptions(): Partial<ManagerOptions & SocketOptions> {
  return {
    // React Native has no reliable long-polling transport: go straight to WebSocket.
    transports: ['websocket'],
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    reconnectionDelay: RECONNECT_DELAY_MS,
    reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
    // No jitter, so the schedule is exactly 1, 2, 4, 8, 16, 30 s (Socket.io doubles each attempt).
    randomizationFactor: 0,
    timeout: 20_000,
    // Read at every (re)connect, so a refreshed access token is used after a reconnection.
    auth: (callback) => {
      callback({ token: useAuthStore.getState().accessToken });
    },
  };
}

export type SocketFactory = (
  url: string,
  options: Partial<ManagerOptions & SocketOptions>,
) => Socket;

/** A `/chat` socket, not yet connected (call `connect()`). */
export function createChatSocket(factory: SocketFactory = io): ChatSocket {
  const socket: ChatSocket = factory(`${API_URL}${CHAT_NAMESPACE}`, chatSocketOptions());
  return socket;
}

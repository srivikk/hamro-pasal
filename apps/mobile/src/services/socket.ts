import {
  CHAT_NAMESPACE,
  CHAT_SOCKET_EVENTS,
  ORDERS_NAMESPACE,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_UNAUTHENTICATED,
  type ChatJoinRequest,
  type OrderSubscribeRequest,
  type RiderLocationRequest,
} from '@hamro-pasal/shared-types';
import { io, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';

import { refreshAccessToken } from '../api/http';
import { API_URL } from '../config/api';
import type { ChatSendPayload } from '../features/dispute/chat-contract';
import { useAuthStore } from '../store/useAuthStore';

/*
 * Socket.io client (SPEC implicit requirement 4 and infrastructure §1). Discrete namespaces:
 * `/orders` for state updates (Phase 8) and `/chat` for dispute chat (Phase 9), both served by the
 * API.
 */

export { CHAT_NAMESPACE };

/** `chat:join` (client → server, acked) and `chat:new_message` (both directions). */
export const CHAT_EVENTS = CHAT_SOCKET_EVENTS;

/** Events the server emits. Payloads are `unknown` until the privacy/contract filter has run. */
export interface ChatServerToClientEvents {
  'chat:new_message': (payload: unknown) => void;
}

/** Events the app emits. Acks are `unknown` until validated (chatJoinAckSchema, chatSendAckSchema). */
export interface ChatClientToServerEvents {
  'chat:join': (payload: ChatJoinRequest, ack: (response: unknown) => void) => void;
  'chat:new_message': (payload: ChatSendPayload, ack: (response: unknown) => void) => void;
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
 * this constant is the value the servers must be configured with (the API's `/orders` uses the
 * same shared constant).
 */
export const HEARTBEAT_INTERVAL_MS = SOCKET_PING_INTERVAL_MS;

/** Server acknowledgement deadline for an emitted chat message or join. */
export const CHAT_ACK_TIMEOUT_MS = 10_000;

/** The delay before reconnection attempt `attempt` (0-based), exactly as the client schedules it. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_DELAY_MS * RECONNECT_FACTOR ** attempt, RECONNECT_DELAY_MAX_MS);
}

/** Transport and reconnection policy shared by every namespace. */
function baseSocketOptions(): Partial<ManagerOptions & SocketOptions> {
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
  };
}

export type SocketFactory = (
  url: string,
  options: Partial<ManagerOptions & SocketOptions>,
) => Socket;

/**
 * The access token for a handshake. The in-memory token if there is one; otherwise (e.g. after an
 * app relaunch, when only the refresh token survived) a fresh one from the HTTP refresh path, which
 * is single-flight and shared with `apiRequest`. Null when there is no session or the refresh
 * could not complete; the server then refuses the handshake and `createAuthenticatedSocket`
 * recovers.
 */
export async function socketAccessToken(): Promise<string | null> {
  const current = useAuthStore.getState().accessToken;
  if (current !== null) return current;
  try {
    return await refreshAccessToken();
  } catch {
    return null; // network / 5xx: the session is kept, the recovery retries with backoff
  }
}

/**
 * Options for an authenticated namespace: the shared transport/backoff policy plus an `auth`
 * callback that resolves `socketAccessToken()` at every (re)connect. `onHandshakeToken` learns
 * which token each handshake carried.
 */
export function authenticatedSocketOptions(
  onHandshakeToken: (token: string | null) => void = () => undefined,
): Partial<ManagerOptions & SocketOptions> {
  return {
    ...baseSocketOptions(),
    auth: (callback) => {
      void socketAccessToken().then((token) => {
        onHandshakeToken(token);
        callback({ token });
      });
    },
  };
}

/** A handshake the server refused because the token was missing, invalid or expired. */
function isUnauthenticated(error: Error): boolean {
  const data: unknown = Reflect.get(error, 'data');
  const code: unknown =
    typeof data === 'object' && data !== null ? Reflect.get(data, 'code') : undefined;
  return error.message === SOCKET_UNAUTHENTICATED || code === SOCKET_UNAUTHENTICATED;
}

export interface SocketConnection<TSocket extends Socket = Socket> {
  readonly socket: TSocket;
  /** Disconnects for good: no reconnection or token recovery happens afterwards. */
  readonly close: () => void;
}

/**
 * A socket for `url` (not yet connected: call `socket.connect()`) that follows the token lifecycle.
 * Every namespace uses it (`/orders`, `/chat`):
 *   - every (re)connect authenticates with `socketAccessToken()`, so a relaunched app refreshes
 *     before its first handshake instead of sending no token;
 *   - a handshake refused as UNAUTHENTICATED (the token expired while the app was offline) is not
 *     retried by Socket.io itself, so this renews the token (once per refused token: a token that
 *     was just renewed and is refused again ends the attempt, no loop) and connects again;
 *   - if the refresh token is refused, the HTTP layer signs the user out and the socket stays down;
 *     if the refresh fails on the network, it is retried on the 1, 2, 4 … 30 s schedule.
 * Rooms do not survive a reconnect: callers join again on every `connect`.
 */
export function createAuthenticatedSocket(url: string, factory: SocketFactory): SocketConnection {
  let handshakeToken: string | null = null;
  let renewedToken: string | null = null;
  let failedRefreshes = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const socket = factory(
    url,
    authenticatedSocketOptions((token) => {
      handshakeToken = token;
    }),
  );

  const reconnect = (): void => {
    if (!closed) socket.connect();
  };

  const onConnect = (): void => {
    renewedToken = null;
    failedRefreshes = 0;
  };

  const onConnectError = (error: Error): void => {
    if (!isUnauthenticated(error)) return; // transport errors: Socket.io's own backoff retries
    const rejected = handshakeToken;
    if (rejected !== null && rejected === renewedToken) return; // renewed and still refused
    const current = useAuthStore.getState().accessToken;
    const renewal =
      current !== null && current !== rejected
        ? Promise.resolve(current) // someone (an HTTP request) already renewed it
        : refreshAccessToken();
    renewal.then(
      (token) => {
        if (token === null) return; // no session any more: stay disconnected
        renewedToken = token;
        reconnect();
      },
      () => {
        retryTimer = setTimeout(reconnect, reconnectDelayMs(failedRefreshes));
        failedRefreshes += 1;
      },
    );
  };

  socket.on('connect', onConnect);
  socket.on('connect_error', onConnectError);

  return {
    socket,
    close: () => {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.disconnect();
    },
  };
}

/* ---------- /chat: dispute chat ---------- */

export type ChatConnection = SocketConnection<ChatSocket>;

/** A `/chat` socket with the shared token lifecycle, not yet connected (call `socket.connect()`). */
export function createChatSocket(factory: SocketFactory = io): ChatConnection {
  const { socket, close } = createAuthenticatedSocket(`${API_URL}${CHAT_NAMESPACE}`, factory);
  const chat: ChatSocket = socket;
  return { socket: chat, close };
}

/* ---------- /orders: real-time order state (customer journey 9, vendor flow step 6) ---------- */

/** Events the server emits. Payloads are `unknown` until validated (orderStateUpdateSchema). */
export interface OrdersServerToClientEvents {
  'order:state_update': (payload: unknown) => void;
  /** Phase 21: the position of the rider carrying a subscribed order (orderRiderLocationSchema). */
  'order:rider_location': (payload: unknown) => void;
}

export interface OrdersClientToServerEvents {
  'orders:subscribe': (payload: OrderSubscribeRequest, ack: (response: unknown) => void) => void;
  'orders:unsubscribe': (payload: OrderSubscribeRequest) => void;
  /** Vendors only: join the shop's room (the ack is `vendorSubscribeAckSchema`). */
  'vendor:subscribe': (payload: Record<string, never>, ack: (response: unknown) => void) => void;
  /** Riders only: report a GPS position (the ack is `riderLocationAckSchema`). */
  'rider:location': (payload: RiderLocationRequest, ack: (response: unknown) => void) => void;
}

export type OrdersSocket = Socket<OrdersServerToClientEvents, OrdersClientToServerEvents>;

export type OrdersConnection = SocketConnection<OrdersSocket>;

/** A `/orders` socket with the shared token lifecycle, not yet connected. */
export function createOrdersSocket(factory: SocketFactory = io): OrdersConnection {
  const { socket, close } = createAuthenticatedSocket(`${API_URL}${ORDERS_NAMESPACE}`, factory);
  const orders: OrdersSocket = socket;
  return { socket: orders, close };
}

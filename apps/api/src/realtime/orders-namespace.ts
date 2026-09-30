import type { Server as HttpServer } from 'node:http';

import {
  ORDER_SOCKET_EVENTS,
  orderRoom,
  ORDERS_NAMESPACE,
  orderSubscribeRequestSchema,
  SOCKET_IO_REDIS_KEY,
  SOCKET_PING_INTERVAL_MS,
  SOCKET_UNAUTHENTICATED,
  type OrderStateUpdate,
  type OrderSubscribeAck,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server, type Namespace } from 'socket.io';

import { verifyAccessToken } from '../auth/access-token';
import type { OrderService } from '../orders/order-service';

export interface OrdersServerToClientEvents {
  'order:state_update': (update: OrderStateUpdate) => void;
}

/** Payloads are `unknown` on arrival: every one is validated before use. */
export interface OrdersClientToServerEvents {
  'orders:subscribe': (payload: unknown, ack?: unknown) => void;
  'orders:unsubscribe': (payload: unknown) => void;
}

export interface OrdersSocketData {
  userId: string;
  role: UserRole;
}

export type OrdersServer = Server<
  OrdersClientToServerEvents,
  OrdersServerToClientEvents,
  Record<string, never>,
  OrdersSocketData
>;
export type OrdersNamespace = Namespace<
  OrdersClientToServerEvents,
  OrdersServerToClientEvents,
  Record<string, never>,
  OrdersSocketData
>;

export interface RealtimeOptions {
  readonly accessTokenSecret: string;
  readonly orders: Pick<OrderService, 'isCustomerOrder'>;
  /**
   * Redis pub/sub connections for `@socket.io/redis-adapter` (horizontal clustering, and how the
   * worker's emitter reaches these sockets). `sub` must be a dedicated connection. Without it,
   * broadcasts stay inside this process (unit tests only).
   */
  readonly redis?: { readonly pub: Redis; readonly sub: Redis; readonly key?: string };
}

export interface RealtimeServer {
  readonly io: OrdersServer;
  readonly orders: OrdersNamespace;
  /** Disconnects every client and closes the HTTP server it is attached to. */
  close(): Promise<void>;
}

/** Only customers track orders in this app (the REST routes apply the same rule). */
const ALLOWED_ROLES: readonly UserRole[] = ['CUSTOMER'];

/**
 * Attaches Socket.io to the API's HTTP server and serves the `/orders` namespace
 * (SPEC implicit requirement 4, infrastructure §1):
 *   - WebSocket transport only, so no sticky sessions are needed behind the load balancer;
 *   - 25 s ping interval (the mobile client follows the server's heartbeat);
 *   - the handshake must carry a valid access token in `auth.token` (same HS256 contract as
 *     `Authorization: Bearer`), otherwise the connection is refused with `UNAUTHENTICATED`;
 *   - `orders:subscribe { order_id }` joins `order:{id}` only if the caller owns the order. Anyone
 *     else gets ORDER_NOT_FOUND, exactly like GET /api/orders/:id, so ids cannot be probed.
 */
export function attachRealtime(httpServer: HttpServer, options: RealtimeOptions): RealtimeServer {
  const io: OrdersServer = new Server(httpServer, {
    transports: ['websocket'],
    pingInterval: SOCKET_PING_INTERVAL_MS,
    pingTimeout: 20_000,
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
  });
  if (options.redis !== undefined) {
    io.adapter(
      createAdapter(options.redis.pub, options.redis.sub, {
        key: options.redis.key ?? SOCKET_IO_REDIS_KEY,
      }),
    );
  }

  const orders: OrdersNamespace = io.of(ORDERS_NAMESPACE);

  orders.use((socket, next) => {
    const auth: unknown = socket.handshake.auth;
    const token: unknown =
      typeof auth === 'object' && auth !== null ? Reflect.get(auth, 'token') : undefined;
    if (typeof token !== 'string' || token === '') {
      next(unauthenticated('Missing access token'));
      return;
    }
    try {
      const claims = verifyAccessToken(token, options.accessTokenSecret);
      if (!ALLOWED_ROLES.includes(claims.role)) {
        next(refusal('FORBIDDEN', 'Order tracking is not available for your role'));
        return;
      }
      socket.data.userId = claims.userId;
      socket.data.role = claims.role;
      next();
    } catch {
      next(unauthenticated('Invalid or expired access token'));
    }
  });

  orders.on('connection', (socket) => {
    socket.on(ORDER_SOCKET_EVENTS.subscribe, (payload, ack) => {
      if (typeof ack !== 'function') return; // the ack is part of the contract
      const reply = (response: OrderSubscribeAck): void => {
        (ack as (response: OrderSubscribeAck) => void)(response);
      };
      const request = orderSubscribeRequestSchema.safeParse(payload);
      if (!request.success) {
        reply({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'order_id is required' } });
        return;
      }
      const orderId = request.data.order_id;
      options.orders.isCustomerOrder(socket.data.userId, orderId).then(
        async (owned) => {
          if (!owned) {
            reply({ ok: false, error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
            return;
          }
          await socket.join(orderRoom(orderId));
          reply({ ok: true, order_id: orderId });
        },
        (error: unknown) => {
          console.error('[api] orders:subscribe failed', error);
          reply({
            ok: false,
            error: { code: 'INTERNAL_SERVER_ERROR', message: 'Please try again' },
          });
        },
      );
    });

    socket.on(ORDER_SOCKET_EVENTS.unsubscribe, (payload) => {
      const request = orderSubscribeRequestSchema.safeParse(payload);
      if (request.success) void socket.leave(orderRoom(request.data.order_id));
    });
    // Rooms are per connection: Socket.io drops them on disconnect, nothing to clean up here.
  });

  return {
    io,
    orders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        void io.close((error) => {
          // Already closed (or never listening) is fine at shutdown.
          if (
            error !== undefined &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          ) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

/** A handshake refusal the client receives as `connect_error` (message + data.code). */
function refusal(code: string, message: string): Error & { data: { code: string } } {
  return Object.assign(new Error(code), { data: { code, message } });
}

function unauthenticated(message: string): Error & { data: { code: string } } {
  return refusal(SOCKET_UNAUTHENTICATED, message);
}

import type { Server as HttpServer } from 'node:http';

import {
  CHAT_NAMESPACE,
  ORDER_SOCKET_EVENTS,
  orderRoom,
  ORDERS_NAMESPACE,
  orderSubscribeRequestSchema,
  SOCKET_IO_REDIS_KEY,
  SOCKET_PING_INTERVAL_MS,
  vendorRoom,
  type OrderRiderLocation,
  type OrderStateUpdate,
  type OrderSubscribeAck,
  type UserRole,
  type VendorSubscribeAck,
} from '@hamro-pasal/shared-types';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server, type Namespace } from 'socket.io';

import type { OrderService } from '../orders/order-service';
import type { VendorOrderService } from '../orders/vendor-order-service';
import {
  serveChatNamespace,
  type ChatNamespace,
  type ChatNamespaceOptions,
} from './chat-namespace';
import {
  serveRiderTelemetry,
  type RiderTelemetry,
  type RiderTelemetryOptions,
} from './rider-telemetry';
import { socketAuth, type AuthenticatedSocketData } from './socket-auth';

export interface OrdersServerToClientEvents {
  'order:state_update': (update: OrderStateUpdate) => void;
  'order:rider_location': (update: OrderRiderLocation) => void;
}

/** Payloads are `unknown` on arrival: every one is validated before use. */
export interface OrdersClientToServerEvents {
  'orders:subscribe': (payload: unknown, ack?: unknown) => void;
  'orders:unsubscribe': (payload: unknown) => void;
  'vendor:subscribe': (payload: unknown, ack?: unknown) => void;
  'rider:location': (payload: unknown, ack?: unknown) => void;
}

export type OrdersSocketData = AuthenticatedSocketData;

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
  /** Finds the vendor a VENDOR user runs, for `vendor:subscribe`. */
  readonly vendors: Pick<VendorOrderService, 'vendorIdForUser'>;
  /**
   * Redis pub/sub connections for `@socket.io/redis-adapter` (horizontal clustering, and how the
   * worker's emitter reaches these sockets). `sub` must be a dedicated connection. Without it,
   * broadcasts stay inside this process (unit tests only).
   */
  readonly redis?: { readonly pub: Redis; readonly sub: Redis; readonly key?: string };
  /** Serves the `/chat` dispute namespace on the same server (and Redis adapter). */
  readonly chat?: Omit<ChatNamespaceOptions, 'accessTokenSecret'>;
  /** Phase 21: riders stream their GPS position; customers get their order's rider pushed. */
  readonly riders?: RiderTelemetryOptions;
}

export interface RealtimeServer {
  readonly io: OrdersServer;
  readonly orders: OrdersNamespace;
  /** The `/chat` namespace, when `options.chat` was given. */
  readonly chat: ChatNamespace | null;
  /** Rider telemetry, when `options.riders` was given. */
  readonly riders: RiderTelemetry | null;
  /** Disconnects every client and closes the HTTP server it is attached to. */
  close(): Promise<void>;
}

/**
 * Customers track their own orders; vendors follow their shop's incoming orders (vendor flow
 * step 6); riders only report their position (Phase 21: `rider:location`, they join no room).
 * The REST routes apply the same split.
 */
const ALLOWED_ROLES: readonly UserRole[] = ['CUSTOMER', 'VENDOR', 'DRIVER'];

/**
 * Attaches Socket.io to the API's HTTP server and serves the `/orders` namespace
 * (SPEC implicit requirement 4, infrastructure §1):
 *   - WebSocket transport only, so no sticky sessions are needed behind the load balancer;
 *   - 25 s ping interval (the mobile client follows the server's heartbeat);
 *   - the handshake must carry a valid access token in `auth.token` (same HS256 contract as
 *     `Authorization: Bearer`), otherwise the connection is refused with `UNAUTHENTICATED`;
 *   - `orders:subscribe { order_id }` joins `order:{id}` only if the caller owns the order. Anyone
 *     else gets ORDER_NOT_FOUND, exactly like GET /api/orders/:id, so ids cannot be probed;
 *   - `vendor:subscribe` (vendors only) joins `vendor:{id}` of the caller's own shop, where the
 *     worker broadcasts every update of that shop's placed orders (new orders included).
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

  orders.use(
    socketAuth(
      options.accessTokenSecret,
      ALLOWED_ROLES,
      'Order tracking is not available for your role',
    ),
  );

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

    socket.on(ORDER_SOCKET_EVENTS.vendorSubscribe, (_payload, ack) => {
      if (typeof ack !== 'function') return; // the ack is part of the contract
      const reply = (response: VendorSubscribeAck): void => {
        (ack as (response: VendorSubscribeAck) => void)(response);
      };
      if (socket.data.role !== 'VENDOR') {
        reply({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Only vendors have a shop room' },
        });
        return;
      }
      options.vendors.vendorIdForUser(socket.data.userId).then(
        async (vendorId) => {
          if (vendorId === null) {
            reply({ ok: false, error: { code: 'VENDOR_NOT_FOUND', message: 'Vendor not found' } });
            return;
          }
          await socket.join(vendorRoom(vendorId));
          reply({ ok: true, vendor_id: vendorId });
        },
        (error: unknown) => {
          console.error('[api] vendor:subscribe failed', error);
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

  // Riders stream GPS in; subscribed customers get their order's rider pushed out.
  const riders = options.riders === undefined ? null : serveRiderTelemetry(orders, options.riders);

  let chat: ChatNamespace | null = null;
  if (options.chat !== undefined) {
    // Same server, so /chat shares the Redis adapter above: a message reaches every instance.
    chat = io.of(CHAT_NAMESPACE);
    serveChatNamespace(chat, { ...options.chat, accessTokenSecret: options.accessTokenSecret });
  }

  return {
    io,
    orders,
    chat,
    riders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        riders?.stop();
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

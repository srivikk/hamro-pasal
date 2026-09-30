import { z } from 'zod';

import { orderStateSchema, paymentStatusSchema } from '../domain/enums';
import type { OrderStateChangedEvent } from '../events/domain-events';

/*
 * Socket.io `/orders` namespace (SPEC implicit requirement 4, infrastructure §1): real-time
 * discrete order state updates for the tracking screen (customer journey 9). The API serves the
 * namespace; the worker publishes into its rooms through the Redis adapter.
 */

export const ORDERS_NAMESPACE = '/orders';

export const ORDER_SOCKET_EVENTS = {
  /** Client → server, with ack: join the room of one of the caller's orders. */
  subscribe: 'orders:subscribe',
  /** Client → server: leave that room. */
  unsubscribe: 'orders:unsubscribe',
  /** Vendor client → server, with ack: join the caller's own vendor room (vendor flow step 6). */
  vendorSubscribe: 'vendor:subscribe',
  /** Server → client: the order's state changed (SPEC: `order:state_update`). */
  stateUpdate: 'order:state_update',
} as const;

/** SPEC infrastructure §1: 25 s heartbeats. The server advertises it; clients follow. */
export const SOCKET_PING_INTERVAL_MS = 25_000;

/**
 * Redis channel prefix shared by the API's `@socket.io/redis-adapter` and the worker's
 * `@socket.io/redis-emitter`. Both sides must use the same value or broadcasts are lost.
 */
export const SOCKET_IO_REDIS_KEY = 'hamro-pasal:socket.io';

/** Error `message` of a handshake refused for a missing, invalid or expired access token. */
export const SOCKET_UNAUTHENTICATED = 'UNAUTHENTICATED';

/** The room every update of one order is broadcast to. */
export function orderRoom(orderId: string): string {
  return `order:${orderId}`;
}

/**
 * The room of one vendor: every update of its orders from placement on, so the vendor dashboard
 * hears about new orders (and customer cancellations) without knowing their ids in advance.
 */
export function vendorRoom(vendorId: string): string {
  return `vendor:${vendorId}`;
}

export const orderSubscribeRequestSchema = z.strictObject({ order_id: z.uuid() });
export type OrderSubscribeRequest = z.infer<typeof orderSubscribeRequestSchema>;

export const orderSubscribeAckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), order_id: z.uuid() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(['VALIDATION_FAILED', 'ORDER_NOT_FOUND', 'INTERNAL_SERVER_ERROR']),
      message: z.string(),
    }),
  }),
]);
export type OrderSubscribeAck = z.infer<typeof orderSubscribeAckSchema>;

/**
 * Ack of `vendor:subscribe` (no payload: the server finds the caller's vendor). FORBIDDEN for a
 * non-vendor, VENDOR_NOT_FOUND for a vendor account without a shop.
 */
export const vendorSubscribeAckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), vendor_id: z.uuid() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(['FORBIDDEN', 'VENDOR_NOT_FOUND', 'INTERNAL_SERVER_ERROR']),
      message: z.string(),
    }),
  }),
]);
export type VendorSubscribeAck = z.infer<typeof vendorSubscribeAckSchema>;

/**
 * Payload of `order:state_update`: the fields of the order snapshot (orderSnapshotSchema) that a
 * state change can alter, so a client patches its cached snapshot in place.
 */
export const orderStateUpdateSchema = z.strictObject({
  order_id: z.uuid(),
  state: orderStateSchema,
  payment_status: paymentStatusSchema,
  refund_required: z.boolean(),
  placed_at: z.iso.datetime().nullable(),
  delivered_at: z.iso.datetime().nullable(),
  /** When the change was committed (database clock). Newer updates carry later values. */
  changed_at: z.iso.datetime(),
});
export type OrderStateUpdate = z.infer<typeof orderStateUpdateSchema>;

/** The socket payload for an `order.state_changed` domain event. */
export function orderStateUpdateFromEvent(event: OrderStateChangedEvent): OrderStateUpdate {
  const { payload } = event;
  return {
    order_id: payload.order_id,
    state: payload.to_state,
    payment_status: payload.payment_status,
    refund_required: payload.refund_required,
    placed_at: payload.placed_at,
    delivered_at: payload.delivered_at,
    changed_at: payload.changed_at,
  };
}

/**
 * Where an `order.state_changed` event is broadcast: always the order's own room (the customer's
 * tracking screen), and the vendor's room once the order has been placed. An order that never
 * reached PLACED (still paying, or paid after its lock expired) is not the vendor's business.
 */
export function orderStateUpdateRooms(event: OrderStateChangedEvent): string[] {
  const { payload } = event;
  return payload.placed_at === null
    ? [orderRoom(payload.order_id)]
    : [orderRoom(payload.order_id), vendorRoom(payload.vendor_id)];
}

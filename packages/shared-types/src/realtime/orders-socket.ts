import { z } from 'zod';

import { orderStateSchema, paymentStatusSchema } from '../domain/enums';
import type { OrderStateChangedEvent } from '../events/domain-events';
import { isWithinNepalBoundingBox } from '../nepal/geo';

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
  /** Rider client → server, optional ack: the rider's current GPS position (Phase 21). */
  riderLocation: 'rider:location',
  /** Server → client: where the rider carrying the subscribed order was last seen (Phase 21). */
  orderRiderLocation: 'order:rider_location',
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

/*
 * Rider telemetry (Phase 21). Riders stream their position on this namespace; customers
 * subscribed to an order receive the position of the rider who accepted its delivery.
 */

/** How often the server pushes `order:rider_location` to an order's subscribers. */
export const RIDER_LOCATION_PUSH_INTERVAL_MS = 5_000;
/** A rider connection may report at most one position per this interval. */
export const RIDER_LOCATION_MIN_INTERVAL_MS = 1_000;
/** A position older than this is not shown to customers (the rider went offline). */
export const RIDER_LOCATION_MAX_AGE_SECONDS = 120;

/** Payload of `rider:location`: WGS 84 degrees, inside Nepal's bounding box. */
export const riderLocationRequestSchema = z
  .strictObject({ latitude: z.number(), longitude: z.number() })
  .refine((point) => isWithinNepalBoundingBox({ lat: point.latitude, lng: point.longitude }), {
    message: 'Coordinates must be inside Nepal',
  });
export type RiderLocationRequest = z.infer<typeof riderLocationRequestSchema>;

/**
 * Ack of `rider:location`. FORBIDDEN for a non-rider, RATE_LIMITED when sent sooner than
 * RIDER_LOCATION_MIN_INTERVAL_MS after the connection's previous position.
 */
export const riderLocationAckSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), recorded_at: z.iso.datetime() }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(['VALIDATION_FAILED', 'FORBIDDEN', 'RATE_LIMITED', 'INTERNAL_SERVER_ERROR']),
      message: z.string(),
    }),
  }),
]);
export type RiderLocationAck = z.infer<typeof riderLocationAckSchema>;

/** Payload of `order:rider_location`. Carries no rider identity: only where the parcel is. */
export const orderRiderLocationSchema = z.strictObject({
  order_id: z.uuid(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** When the server received this position from the rider's device. */
  recorded_at: z.iso.datetime(),
});
export type OrderRiderLocation = z.infer<typeof orderRiderLocationSchema>;

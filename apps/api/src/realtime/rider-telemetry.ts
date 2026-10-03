import {
  ORDER_SOCKET_EVENTS,
  RIDER_LOCATION_MIN_INTERVAL_MS,
  RIDER_LOCATION_PUSH_INTERVAL_MS,
  riderLocationRequestSchema,
  type OrderRiderLocation,
  type RiderLocationAck,
} from '@hamro-pasal/shared-types';

import type { DeliveryService } from '../deliveries/delivery-service';
import type { RiderLocationStore } from '../deliveries/rider-location-store';
import type { OrdersNamespace } from './orders-namespace';

export interface RiderTelemetryOptions {
  readonly locations: Pick<RiderLocationStore, 'record' | 'latest'>;
  /** Finds the rider on the road for each tracked order. */
  readonly deliveries: Pick<DeliveryService, 'ridersOnTheRoad'>;
  /** Tests only. Production uses RIDER_LOCATION_PUSH_INTERVAL_MS. */
  readonly pushIntervalMs?: number;
  /** Tests only. Production uses RIDER_LOCATION_MIN_INTERVAL_MS. */
  readonly minReportIntervalMs?: number;
}

export interface RiderTelemetry {
  /** One push round now (the timer calls this; tests may too). */
  push(): Promise<void>;
  stop(): void;
}

const ORDER_ROOM_PREFIX = 'order:';

/**
 * Rider telemetry on `/orders` (Phase 21).
 *
 * In: a DRIVER connection emits `rider:location { latitude, longitude }`. The rider is the
 * handshake's token subject (the payload cannot name one); the position must lie inside Nepal's
 * bounding box and is stored with GEOADD (`RiderLocationStore`). One report per connection per
 * RIDER_LOCATION_MIN_INTERVAL_MS; the ack is optional, so a rider may stream without waiting.
 *
 * Out: every RIDER_LOCATION_PUSH_INTERVAL_MS this instance takes the order rooms its own sockets
 * are in (membership was ownership-checked at `orders:subscribe`), finds with one query the
 * riders on the road for them, reads their positions with one GEOPOS, and emits
 * `order:rider_location` to each room whose rider reported since the last push. Each API instance
 * serves its own sockets (`local`), so nothing is sent twice through the Redis adapter. An order
 * without an accepted delivery, or whose rider is stale, gets nothing.
 */
export function serveRiderTelemetry(
  orders: OrdersNamespace,
  options: RiderTelemetryOptions,
): RiderTelemetry {
  const minReportIntervalMs = options.minReportIntervalMs ?? RIDER_LOCATION_MIN_INTERVAL_MS;

  orders.on('connection', (socket) => {
    let lastReportAt = 0;
    socket.on(ORDER_SOCKET_EVENTS.riderLocation, (payload, ack) => {
      const reply = (response: RiderLocationAck): void => {
        if (typeof ack === 'function') (ack as (response: RiderLocationAck) => void)(response);
      };
      if (socket.data.role !== 'DRIVER') {
        reply({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Only riders report a position' },
        });
        return;
      }
      const request = riderLocationRequestSchema.safeParse(payload);
      if (!request.success) {
        reply({
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'latitude and longitude inside Nepal are required',
          },
        });
        return;
      }
      const now = Date.now();
      if (now - lastReportAt < minReportIntervalMs) {
        reply({ ok: false, error: { code: 'RATE_LIMITED', message: 'Position sent too soon' } });
        return;
      }
      lastReportAt = now;
      options.locations.record(socket.data.userId, request.data).then(
        (recordedAt) => {
          reply({ ok: true, recorded_at: recordedAt.toISOString() });
        },
        (error: unknown) => {
          console.error('[api] rider:location failed', error);
          reply({
            ok: false,
            error: { code: 'INTERNAL_SERVER_ERROR', message: 'Please try again' },
          });
        },
      );
    });
  });

  /** order id → the report time last pushed to its room, so an unchanged position is not resent. */
  const lastPushed = new Map<string, number>();

  const push = async (): Promise<void> => {
    const orderIds = [...orders.adapter.rooms.keys()]
      .filter((room) => room.startsWith(ORDER_ROOM_PREFIX))
      .map((room) => room.slice(ORDER_ROOM_PREFIX.length));
    for (const orderId of lastPushed.keys()) {
      if (!orderIds.includes(orderId)) lastPushed.delete(orderId);
    }
    if (orderIds.length === 0) return;

    const riders = await options.deliveries.ridersOnTheRoad(orderIds);
    if (riders.size === 0) return;
    const locations = await options.locations.latest([...riders.values()]);
    for (const [orderId, riderId] of riders) {
      const location = locations.get(riderId);
      if (location === undefined) continue;
      const recordedAt = location.recordedAt.getTime();
      if (lastPushed.get(orderId) === recordedAt) continue;
      lastPushed.set(orderId, recordedAt);
      const update: OrderRiderLocation = {
        order_id: orderId,
        latitude: location.latitude,
        longitude: location.longitude,
        recorded_at: location.recordedAt.toISOString(),
      };
      orders.local
        .to(`${ORDER_ROOM_PREFIX}${orderId}`)
        .emit(ORDER_SOCKET_EVENTS.orderRiderLocation, update);
    }
  };

  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow round never overlaps the next
    running = true;
    push()
      .catch((error: unknown) => {
        console.error('[api] rider location push failed', error);
      })
      .finally(() => {
        running = false;
      });
  }, options.pushIntervalMs ?? RIDER_LOCATION_PUSH_INTERVAL_MS);
  timer.unref();

  return {
    push,
    stop: () => {
      clearInterval(timer);
    },
  };
}

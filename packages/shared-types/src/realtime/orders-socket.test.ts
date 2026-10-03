import { randomUUID } from 'node:crypto';

import { DOMAIN_EVENT_TOPICS, domainEventSchema } from '../events/domain-events';
import {
  ORDER_SOCKET_EVENTS,
  orderRiderLocationSchema,
  orderRoom,
  orderStateUpdateFromEvent,
  orderStateUpdateRooms,
  orderStateUpdateSchema,
  orderSubscribeAckSchema,
  orderSubscribeRequestSchema,
  ORDERS_NAMESPACE,
  RIDER_LOCATION_MAX_AGE_SECONDS,
  RIDER_LOCATION_MIN_INTERVAL_MS,
  RIDER_LOCATION_PUSH_INTERVAL_MS,
  riderLocationAckSchema,
  riderLocationRequestSchema,
  SOCKET_PING_INTERVAL_MS,
  vendorRoom,
  vendorSubscribeAckSchema,
} from './orders-socket';

const orderId = randomUUID();

function stateChanged(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    event_type: 'order.state_changed',
    event_version: 1,
    occurred_at: '2026-09-30T10:00:00.000Z',
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      customer_id: randomUUID(),
      vendor_id: randomUUID(),
      from_state: 'PLACED',
      to_state: 'CANCELED',
      payment_status: 'PENDING',
      refund_required: false,
      placed_at: '2026-09-30T09:59:30.000Z',
      delivered_at: null,
      changed_at: '2026-09-30T10:00:00.000Z',
      ...overrides,
    },
  };
}

describe('order.state_changed', () => {
  it('is a domain event on the order.lifecycle topic', () => {
    const event = domainEventSchema.parse(stateChanged());

    expect(event.event_type).toBe('order.state_changed');
    expect(DOMAIN_EVENT_TOPICS['order.state_changed']).toBe('order.lifecycle');
  });

  it('allows a null from_state (creation) but not an unknown state', () => {
    expect(domainEventSchema.safeParse(stateChanged({ from_state: null })).success).toBe(true);
    expect(domainEventSchema.safeParse(stateChanged({ to_state: 'ARRIVED' })).success).toBe(false);
  });
});

describe('/orders socket contract', () => {
  it('uses the SPEC namespace, event name and 25 s heartbeat', () => {
    expect(ORDERS_NAMESPACE).toBe('/orders');
    expect(ORDER_SOCKET_EVENTS.stateUpdate).toBe('order:state_update');
    expect(SOCKET_PING_INTERVAL_MS).toBe(25_000);
  });

  it('names one room per order', () => {
    expect(orderRoom(orderId)).toBe(`order:${orderId}`);
  });

  it('builds the socket payload from the event (to_state becomes state)', () => {
    const event = domainEventSchema.parse(stateChanged());
    if (event.event_type !== 'order.state_changed') throw new Error('unexpected event');

    const update = orderStateUpdateFromEvent(event);

    expect(orderStateUpdateSchema.parse(update)).toEqual({
      order_id: orderId,
      state: 'CANCELED',
      payment_status: 'PENDING',
      refund_required: false,
      placed_at: '2026-09-30T09:59:30.000Z',
      delivered_at: null,
      changed_at: '2026-09-30T10:00:00.000Z',
    });
  });

  it('validates subscribe requests and acks strictly', () => {
    expect(orderSubscribeRequestSchema.safeParse({ order_id: 'nope' }).success).toBe(false);
    expect(orderSubscribeRequestSchema.safeParse({ order_id: orderId, extra: true }).success).toBe(
      false,
    );
    expect(orderSubscribeAckSchema.parse({ ok: true, order_id: orderId }).ok).toBe(true);
    expect(
      orderSubscribeAckSchema.safeParse({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'x' },
      }).success,
    ).toBe(true);
  });
});

describe('vendor room (Phase 10)', () => {
  const vendorId = randomUUID();

  function parsed(overrides: Record<string, unknown>) {
    const event = domainEventSchema.parse(stateChanged({ vendor_id: vendorId, ...overrides }));
    if (event.event_type !== 'order.state_changed') throw new Error('unexpected event');
    return event;
  }

  it('names one room per vendor', () => {
    expect(vendorRoom(vendorId)).toBe(`vendor:${vendorId}`);
    expect(ORDER_SOCKET_EVENTS.vendorSubscribe).toBe('vendor:subscribe');
  });

  it("sends placed orders to the order's room and the vendor's room", () => {
    const placed = parsed({ from_state: 'PENDING_PAYMENT', to_state: 'PLACED' });
    const canceled = parsed({ from_state: 'PREPARING', to_state: 'CANCELED' });

    expect(orderStateUpdateRooms(placed)).toEqual([orderRoom(orderId), vendorRoom(vendorId)]);
    expect(orderStateUpdateRooms(canceled)).toEqual([orderRoom(orderId), vendorRoom(vendorId)]);
  });

  it('keeps orders that were never placed away from the vendor', () => {
    const created = parsed({ from_state: null, to_state: 'PENDING_PAYMENT', placed_at: null });
    const paidTooLate = parsed({
      from_state: 'PENDING_PAYMENT',
      to_state: 'FAILED',
      payment_status: 'PAID',
      placed_at: null,
    });

    expect(orderStateUpdateRooms(created)).toEqual([orderRoom(orderId)]);
    expect(orderStateUpdateRooms(paidTooLate)).toEqual([orderRoom(orderId)]);
  });

  it('validates vendor:subscribe acks strictly', () => {
    expect(vendorSubscribeAckSchema.parse({ ok: true, vendor_id: vendorId }).ok).toBe(true);
    expect(
      vendorSubscribeAckSchema.safeParse({ ok: false, error: { code: 'FORBIDDEN', message: 'x' } })
        .success,
    ).toBe(true);
    expect(
      vendorSubscribeAckSchema.safeParse({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'x' },
      }).success,
    ).toBe(false);
    expect(vendorSubscribeAckSchema.safeParse({ ok: true, vendor_id: 'nope' }).success).toBe(false);
  });
});

describe('rider telemetry contracts (Phase 21)', () => {
  it('names the two events', () => {
    expect(ORDER_SOCKET_EVENTS.riderLocation).toBe('rider:location');
    expect(ORDER_SOCKET_EVENTS.orderRiderLocation).toBe('order:rider_location');
  });

  it('accepts a position inside Nepal and nothing else', () => {
    const ok = { latitude: 27.7154, longitude: 85.3123 };

    expect(riderLocationRequestSchema.parse(ok)).toEqual(ok);
    // Swapped axes, outside the box, non-numbers and extra keys (a rider id cannot be claimed).
    expect(
      riderLocationRequestSchema.safeParse({ latitude: 85.3123, longitude: 27.7154 }).success,
    ).toBe(false);
    expect(
      riderLocationRequestSchema.safeParse({ latitude: 28.6139, longitude: 77.209 }).success,
    ).toBe(false);
    expect(
      riderLocationRequestSchema.safeParse({ latitude: '27.7', longitude: 85.3 }).success,
    ).toBe(false);
    expect(
      riderLocationRequestSchema.safeParse({ latitude: Number.NaN, longitude: 85.3 }).success,
    ).toBe(false);
    expect(riderLocationRequestSchema.safeParse({ ...ok, rider_id: randomUUID() }).success).toBe(
      false,
    );
    expect(riderLocationRequestSchema.safeParse({ latitude: 27.7154 }).success).toBe(false);
  });

  it('acks with the recording time or one of four codes', () => {
    expect(
      riderLocationAckSchema.safeParse({ ok: true, recorded_at: '2026-10-03T10:00:00.000Z' })
        .success,
    ).toBe(true);
    for (const code of [
      'VALIDATION_FAILED',
      'FORBIDDEN',
      'RATE_LIMITED',
      'INTERNAL_SERVER_ERROR',
    ]) {
      expect(
        riderLocationAckSchema.safeParse({ ok: false, error: { code, message: 'x' } }).success,
      ).toBe(true);
    }
    expect(
      riderLocationAckSchema.safeParse({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'x' },
      }).success,
    ).toBe(false);
  });

  it('pushes a position to customers without any rider identity', () => {
    const push = {
      order_id: orderId,
      latitude: 27.7154,
      longitude: 85.3123,
      recorded_at: '2026-10-03T10:00:00.000Z',
    };

    expect(orderRiderLocationSchema.parse(push)).toEqual(push);
    expect(orderRiderLocationSchema.safeParse({ ...push, rider_id: randomUUID() }).success).toBe(
      false,
    );
    expect(orderRiderLocationSchema.safeParse({ ...push, phone: '+9779800000021' }).success).toBe(
      false,
    );
    expect(orderRiderLocationSchema.safeParse({ ...push, latitude: 91 }).success).toBe(false);
  });

  it('keeps the push period above the rider rate limit and below the staleness bound', () => {
    expect(RIDER_LOCATION_MIN_INTERVAL_MS).toBeLessThan(RIDER_LOCATION_PUSH_INTERVAL_MS);
    expect(RIDER_LOCATION_PUSH_INTERVAL_MS).toBeLessThan(RIDER_LOCATION_MAX_AGE_SECONDS * 1000);
  });
});

import { randomUUID } from 'node:crypto';

import { DOMAIN_EVENT_TOPICS, domainEventSchema } from '../events/domain-events';
import {
  ORDER_SOCKET_EVENTS,
  orderRoom,
  orderStateUpdateFromEvent,
  orderStateUpdateRooms,
  orderStateUpdateSchema,
  orderSubscribeAckSchema,
  orderSubscribeRequestSchema,
  ORDERS_NAMESPACE,
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

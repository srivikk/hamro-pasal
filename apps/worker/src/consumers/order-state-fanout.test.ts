import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type { DomainEvent, OrderState, OrderStateUpdate } from '@hamro-pasal/shared-types';

import {
  orderStateFanoutConsumer,
  RedisOrderRoomBroadcaster,
  type EventDeduplicator,
  type OrderRoomBroadcaster,
} from './order-state-fanout';

const orderId = randomUUID();
const vendorId = randomUUID();

function stateChanged(
  overrides: { to_state?: OrderState; event_id?: string; placed_at?: string | null } = {},
): DomainEvent {
  return {
    event_id: overrides.event_id ?? randomUUID(),
    event_type: 'order.state_changed',
    event_version: 1,
    occurred_at: '2026-09-30T10:00:00.000Z',
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      customer_id: randomUUID(),
      vendor_id: vendorId,
      from_state: 'PLACED',
      to_state: overrides.to_state ?? 'CANCELED',
      payment_status: 'PENDING',
      refund_required: false,
      placed_at:
        overrides.placed_at === undefined ? '2026-09-30T09:59:30.000Z' : overrides.placed_at,
      delivered_at: null,
      changed_at: '2026-09-30T10:00:00.000Z',
    },
  };
}

function message(value: string | null, offset = '0'): KafkaJS.EachMessagePayload {
  return {
    topic: 'order.lifecycle',
    partition: 0,
    message: {
      key: Buffer.from(orderId),
      value: value === null ? null : Buffer.from(value),
      offset,
      timestamp: String(Date.now()),
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  };
}

class RecordingBroadcaster implements OrderRoomBroadcaster {
  readonly sent: OrderStateUpdate[] = [];
  readonly rooms: (readonly string[])[] = [];
  failNext: Error | null = null;

  broadcast(update: OrderStateUpdate, rooms: readonly string[]): Promise<void> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.sent.push(update);
    this.rooms.push(rooms);
    return Promise.resolve();
  }
}

class MemoryDeduplicator implements EventDeduplicator {
  readonly seen = new Set<string>();

  claim(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return Promise.resolve(false);
    this.seen.add(eventId);
    return Promise.resolve(true);
  }

  release(eventId: string): Promise<void> {
    this.seen.delete(eventId);
    return Promise.resolve();
  }
}

function setup() {
  const broadcaster = new RecordingBroadcaster();
  const deduplicator = new MemoryDeduplicator();
  const invalid: string[] = [];
  const consumer = orderStateFanoutConsumer({
    broadcaster,
    deduplicator,
    onInvalidMessage: (reason) => invalid.push(reason),
  });
  return { broadcaster, deduplicator, invalid, consumer };
}

describe('orderStateFanoutConsumer', () => {
  it('listens to the order.lifecycle topic', () => {
    expect(setup().consumer.topic).toBe('order.lifecycle');
  });

  it('broadcasts an order.state_changed event as the order:state_update payload', async () => {
    const { consumer, broadcaster } = setup();

    await consumer.handle(message(JSON.stringify(stateChanged())));

    expect(broadcaster.sent).toEqual([
      {
        order_id: orderId,
        state: 'CANCELED',
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: '2026-09-30T09:59:30.000Z',
        delivered_at: null,
        changed_at: '2026-09-30T10:00:00.000Z',
      },
    ]);
  });

  it("sends a placed order's updates to its room and its vendor's room (Phase 10)", async () => {
    const { consumer, broadcaster } = setup();

    await consumer.handle(message(JSON.stringify(stateChanged({ to_state: 'PREPARING' }))));

    expect(broadcaster.rooms).toEqual([[`order:${orderId}`, `vendor:${vendorId}`]]);
  });

  it('keeps an order that was never placed away from the vendor room', async () => {
    const { consumer, broadcaster } = setup();

    await consumer.handle(
      message(JSON.stringify(stateChanged({ to_state: 'PENDING_PAYMENT', placed_at: null }))),
    );

    expect(broadcaster.rooms).toEqual([[`order:${orderId}`]]);
  });

  it('broadcasts a redelivered event only once (dedupe on event_id)', async () => {
    const { consumer, broadcaster } = setup();
    const event = JSON.stringify(stateChanged());

    await consumer.handle(message(event, '1'));
    await consumer.handle(message(event, '1'));

    expect(broadcaster.sent).toHaveLength(1);
  });

  it('ignores other order lifecycle events', async () => {
    const { consumer, broadcaster } = setup();
    const placed: DomainEvent = {
      event_id: randomUUID(),
      event_type: 'order.placed',
      event_version: 1,
      occurred_at: '2026-09-30T10:00:00.000Z',
      aggregate_id: orderId,
      payload: {
        order_id: orderId,
        reservation_id: randomUUID(),
        vendor_id: randomUUID(),
        customer_id: randomUUID(),
        payment_method: 'COD',
        fulfillment_locked: 'SELF_DELIVERY',
        subtotal: 1000,
        delivery_fee: 50,
        items: [{ product_id: randomUUID(), quantity: 1 }],
      },
    };

    await consumer.handle(message(JSON.stringify(placed)));

    expect(broadcaster.sent).toEqual([]);
  });

  it('skips (does not retry forever) a message that is not a valid domain event', async () => {
    const { consumer, broadcaster, invalid } = setup();

    await consumer.handle(message('not json', '7'));
    await consumer.handle(message(JSON.stringify({ event_type: 'order.state_changed' }), '8'));
    await consumer.handle(message(null, '9'));

    expect(broadcaster.sent).toEqual([]);
    expect(invalid).toHaveLength(3);
    expect(invalid[0]).toMatch(/offset 7/);
  });

  it('fails the message and forgets the claim when the broadcast fails, so the retry delivers', async () => {
    const { consumer, broadcaster, deduplicator } = setup();
    const event = stateChanged();
    broadcaster.failNext = new Error('redis down');

    await expect(consumer.handle(message(JSON.stringify(event)))).rejects.toThrow('redis down');
    expect(deduplicator.seen.has(event.event_id)).toBe(false);

    await consumer.handle(message(JSON.stringify(event)));
    expect(broadcaster.sent).toHaveLength(1);
  });
});

describe('RedisOrderRoomBroadcaster', () => {
  const update: OrderStateUpdate = {
    order_id: orderId,
    state: 'PREPARING',
    payment_status: 'PAID',
    refund_required: false,
    placed_at: '2026-09-30T09:59:30.000Z',
    delivered_at: null,
    changed_at: '2026-09-30T10:01:00.000Z',
  };

  it('publishes to the /orders channel of exactly the order room', async () => {
    const channels: string[] = [];
    const redis = {
      publish: (channel: string) => {
        channels.push(channel);
        return Promise.resolve(1);
      },
    };

    await new RedisOrderRoomBroadcaster(redis, 'test-key').broadcast(update, [`order:${orderId}`]);

    expect(channels).toEqual([`test-key#/orders#order:${orderId}#`]);
  });

  it('publishes one message for several rooms (the adapter delivers it once per socket)', async () => {
    const channels: string[] = [];
    const redis = {
      publish: (channel: string) => {
        channels.push(channel);
        return Promise.resolve(1);
      },
    };

    await new RedisOrderRoomBroadcaster(redis, 'test-key').broadcast(update, [
      `order:${orderId}`,
      `vendor:${vendorId}`,
    ]);

    // With more than one room the emitter uses the namespace channel and lists the rooms inside.
    expect(channels).toEqual(['test-key#/orders#']);
  });

  it('uses the key the API adapter subscribes with by default', async () => {
    const channels: string[] = [];
    const redis = {
      publish: (channel: string) => {
        channels.push(channel);
        return Promise.resolve(0);
      },
    };

    await new RedisOrderRoomBroadcaster(redis).broadcast(update, [`order:${orderId}`]);

    expect(channels).toEqual([`hamro-pasal:socket.io#/orders#order:${orderId}#`]);
  });

  it('rejects when Redis refuses the publish (the emitter alone would swallow it)', async () => {
    const redis = { publish: () => Promise.reject(new Error('connection lost')) };

    await expect(
      new RedisOrderRoomBroadcaster(redis).broadcast(update, [`order:${orderId}`]),
    ).rejects.toThrow('connection lost');
  });
});

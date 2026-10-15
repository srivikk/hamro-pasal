import { randomUUID } from 'node:crypto';

import type { KafkaJS } from '@hamro-pasal/kafka';
import type {
  DomainEvent,
  OrderState,
  VendorAcceptanceTimeoutJob,
} from '@hamro-pasal/shared-types';
import type { JobsOptions, Queue } from 'bullmq';

import { routeByTopic } from './index';
import {
  BullVendorAcceptanceTimers,
  vendorSlaSchedulerConsumer,
  type VendorAcceptanceTimerScheduler,
} from './vendor-sla-scheduler';

const orderId = randomUUID();
const vendorId = randomUUID();
const PLACED_AT = '2026-09-30T10:00:00.000Z';

function stateChanged(
  fromState: OrderState | null,
  toState: OrderState,
  placedAt: string | null = PLACED_AT,
): DomainEvent {
  return {
    event_id: randomUUID(),
    event_type: 'order.state_changed',
    event_version: 1,
    occurred_at: PLACED_AT,
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      customer_id: randomUUID(),
      vendor_id: vendorId,
      from_state: fromState,
      to_state: toState,
      payment_status: 'PENDING',
      refund_required: false,
      placed_at: placedAt,
      delivered_at: null,
      changed_at: PLACED_AT,
    },
  };
}

function message(value: string | null, topic = 'order.lifecycle'): KafkaJS.EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: {
      key: Buffer.from(orderId),
      value: value === null ? null : Buffer.from(value),
      offset: '0',
      timestamp: String(Date.now()),
      attributes: 0,
      headers: {},
    },
    heartbeat: () => Promise.resolve(),
    pause: () => () => undefined,
  };
}

class RecordingTimers implements VendorAcceptanceTimerScheduler {
  readonly scheduled: { job: VendorAcceptanceTimeoutJob; placedAt: Date }[] = [];

  schedule(job: VendorAcceptanceTimeoutJob, placedAt: Date): Promise<void> {
    this.scheduled.push({ job, placedAt });
    return Promise.resolve();
  }
}

function setup() {
  const timers = new RecordingTimers();
  const invalid: string[] = [];
  const consumer = vendorSlaSchedulerConsumer({
    timers,
    onInvalidMessage: (reason) => invalid.push(reason),
  });
  return { timers, invalid, consumer };
}

describe('vendorSlaSchedulerConsumer', () => {
  it('listens to order.lifecycle, beside the fan-out', () => {
    expect(setup().consumer.topic).toBe('order.lifecycle');
  });

  it('starts the 90 s escalation and the 5-minute expiry, anchored on placed_at, when an order becomes PLACED', async () => {
    const { consumer, timers } = setup();

    await consumer.handle(message(JSON.stringify(stateChanged('PENDING_PAYMENT', 'PLACED'))));

    expect(timers.scheduled).toEqual([
      {
        job: { order_id: orderId, vendor_id: vendorId, kind: 'ESCALATE' },
        placedAt: new Date(PLACED_AT),
      },
      {
        job: { order_id: orderId, vendor_id: vendorId, kind: 'EXPIRE' },
        placedAt: new Date(PLACED_AT),
      },
    ]);
  });

  it('ignores every other transition and every other event type', async () => {
    const { consumer, timers } = setup();
    const others = [
      stateChanged(null, 'PENDING_PAYMENT', null),
      stateChanged('PLACED', 'PREPARING'),
      stateChanged('PLACED', 'CANCELED'),
      stateChanged('PENDING_PAYMENT', 'FAILED', null),
    ];

    for (const event of others) await consumer.handle(message(JSON.stringify(event)));
    await consumer.handle(
      message(
        JSON.stringify({
          ...stateChanged('PENDING_PAYMENT', 'PLACED'),
          event_type: 'order.placed',
        }),
      ),
    );

    expect(timers.scheduled).toEqual([]);
  });

  it('skips malformed messages instead of blocking the partition', async () => {
    const { consumer, timers, invalid } = setup();

    await consumer.handle(message('not json'));
    await consumer.handle(message(null));
    await consumer.handle(
      message(JSON.stringify(stateChanged('PENDING_PAYMENT', 'PLACED', null))), // no placed_at
    );

    expect(timers.scheduled).toEqual([]);
    expect(invalid).toHaveLength(3);
  });

  it('fails the message when the timer cannot be scheduled, so Kafka redelivers it', async () => {
    const consumer = vendorSlaSchedulerConsumer({
      timers: { schedule: () => Promise.reject(new Error('redis down')) },
    });

    await expect(
      consumer.handle(message(JSON.stringify(stateChanged('PENDING_PAYMENT', 'PLACED')))),
    ).rejects.toThrow('redis down');
  });
});

describe('BullVendorAcceptanceTimers', () => {
  function recordingQueue() {
    const added: { name: string; data: VendorAcceptanceTimeoutJob; opts: JobsOptions }[] = [];
    const queue = {
      add: (name: string, data: VendorAcceptanceTimeoutJob, opts: JobsOptions) => {
        added.push({ name, data, opts });
        return Promise.resolve();
      },
    } as unknown as Queue<VendorAcceptanceTimeoutJob>;
    return { queue, added };
  }

  it('adds a delayed job keyed by the order that fires at placed_at + 90 s', async () => {
    const { queue, added } = recordingQueue();
    const now = new Date(Date.parse(PLACED_AT) + 4_000); // the event arrived 4 s after placement
    const timers = new BullVendorAcceptanceTimers(queue, () => now);

    await timers.schedule({ order_id: orderId, vendor_id: vendorId }, new Date(PLACED_AT));

    expect(added).toEqual([
      {
        name: 'vendor-acceptance-timeout',
        data: { order_id: orderId, vendor_id: vendorId, kind: 'ESCALATE' },
        opts: expect.objectContaining({ jobId: orderId, delay: 86_000 }) as unknown,
      },
    ]);
  });

  it('adds the expiry under its own id, firing at placed_at + 5 minutes (step 7.3)', async () => {
    const { queue, added } = recordingQueue();
    const now = new Date(Date.parse(PLACED_AT) + 4_000);
    const timers = new BullVendorAcceptanceTimers(queue, () => now);

    await timers.schedule(
      { order_id: orderId, vendor_id: vendorId, kind: 'EXPIRE' },
      new Date(PLACED_AT),
    );

    expect(added).toEqual([
      {
        name: 'vendor-acceptance-timeout',
        data: { order_id: orderId, vendor_id: vendorId, kind: 'EXPIRE' },
        opts: expect.objectContaining({ jobId: `expire-${orderId}`, delay: 296_000 }) as unknown,
      },
    ]);
  });
});

describe('routeByTopic', () => {
  it('runs every consumer of a topic in registration order, one handler per topic', async () => {
    const calls: string[] = [];
    const consumer = (name: string, topic: string) => ({
      topic,
      handle: () => {
        calls.push(name);
        return Promise.resolve();
      },
    });

    const routes = routeByTopic([
      consumer('fanout', 'order.lifecycle'),
      consumer('refunds', 'payment.reconciliation'),
      consumer('sla', 'order.lifecycle'),
    ]);
    await routes.get('order.lifecycle')?.(message('{}'));

    expect([...routes.keys()]).toEqual(['order.lifecycle', 'payment.reconciliation']);
    expect(calls).toEqual(['fanout', 'sla']);
  });

  it('fails the message if any consumer fails (Kafka redelivers it to all of them)', async () => {
    const routes = routeByTopic([
      { topic: 'order.lifecycle', handle: () => Promise.reject(new Error('broadcast failed')) },
      { topic: 'order.lifecycle', handle: () => Promise.resolve() },
    ]);

    await expect(routes.get('order.lifecycle')?.(message('{}'))).rejects.toThrow(
      'broadcast failed',
    );
  });
});

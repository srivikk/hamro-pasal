import { randomUUID } from 'node:crypto';

import { createDatabase, enqueueDomainEvent, outboxEvents, type Database } from '@hamro-pasal/db';
import { createIdempotentProducer, createKafka, DomainEventPublisher } from '@hamro-pasal/kafka';
import { parseKafkaEnv, type DomainEvent } from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';

import { OutboxRelay, type EventPublisher } from '../src/outbox/outbox-relay';

/**
 * Settles with `promise`, or rejects after `ms`. Every wait on Kafka goes through it: a test that
 * awaits a message that never comes would otherwise be abandoned by Jest at its timeout with its
 * `finally` never run, leaving the consumer connected and polling, and Jest never exits.
 */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what}: nothing after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** Transactional outbox relay against real PostgreSQL (and, end-to-end, real Kafka). */
describe('OutboxRelay', () => {
  let db: Database;
  /** Every Kafka client a test opened; whatever a failed test left connected is closed here. */
  const kafkaClients: { disconnect: () => Promise<void> }[] = [];

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
  });

  afterAll(async () => {
    await Promise.allSettled(
      kafkaClients.map((client) => within(client.disconnect(), 10_000, 'Kafka disconnect')),
    );
    await db.$client.end();
  }, 30_000);

  class RecordingPublisher implements EventPublisher {
    readonly published: DomainEvent[] = [];
    failWith: Error | null = null;

    publish(events: readonly DomainEvent[]): Promise<void> {
      if (this.failWith !== null) return Promise.reject(this.failWith);
      this.published.push(...events);
      return Promise.resolve();
    }
  }

  async function enqueueLocked(): Promise<DomainEvent> {
    const reservationId = randomUUID();
    return enqueueDomainEvent(db, {
      type: 'order.locked',
      aggregateId: reservationId,
      payload: {
        reservation_id: reservationId,
        vendor_id: randomUUID(),
        customer_id: randomUUID(),
        items: [{ product_id: randomUUID(), quantity: 1 }],
        locked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    });
  }

  async function rowsFor(ids: string[]) {
    return db.select().from(outboxEvents).where(inArray(outboxEvents.id, ids));
  }

  /**
   * Runs the relay until the outbox has nothing left to publish. Bounded: a publisher that keeps
   * failing fails the test instead of looping for ever.
   */
  async function drain(relay: OutboxRelay, maxRounds = 200): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      const result = await relay.runOnce();
      if (result.published + result.failed === 0) return;
    }
    throw new Error(`outbox not drained after ${String(maxRounds)} rounds`);
  }

  /** A connected producer and consumer, registered for afterAll before they connect. */
  async function connectKafka(groupId: string) {
    const kafka = createKafka(parseKafkaEnv(process.env));
    const producer = createIdempotentProducer(kafka);
    const consumer = kafka.consumer({ kafkaJS: { groupId, fromBeginning: false } });
    kafkaClients.push(producer, consumer);
    await within(Promise.all([producer.connect(), consumer.connect()]), 10_000, 'Kafka connect');
    return { producer, consumer };
  }

  /** Waits (bounded) until the consumer has partitions, so it sees what is published next. */
  async function awaitAssignment(consumer: { assignment: () => unknown[] }): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (consumer.assignment().length === 0) {
      if (Date.now() >= deadline) throw new Error('Kafka consumer got no partitions in 20 s');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it('publishes committed events in occurrence order and marks them published', async () => {
    const publisher = new RecordingPublisher();
    const events = [await enqueueLocked(), await enqueueLocked(), await enqueueLocked()];

    await drain(new OutboxRelay(db, publisher));

    const ids = events.map((e) => e.event_id);
    expect(publisher.published.filter((e) => ids.includes(e.event_id))).toEqual(events);
    expect((await rowsFor(ids)).every((r) => r.published_at !== null)).toBe(true);
  });

  it('keeps events and records the error when Kafka is unavailable, then retries', async () => {
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay(db, publisher, { onError: () => undefined });
    const event = await enqueueLocked();

    publisher.failWith = new Error('broker down');
    await relay.runOnce();
    const [failed] = await rowsFor([event.event_id]);
    expect(failed).toMatchObject({
      published_at: null,
      publish_attempts: 1,
      last_error: 'Error: broker down',
    });

    publisher.failWith = null;
    await drain(relay);
    const [published] = await rowsFor([event.event_id]);
    expect(published?.published_at).not.toBeNull();
    expect(published?.last_error).toBeNull();
  });

  it('sets aside a malformed row without blocking valid events', async () => {
    const poisonId = randomUUID();
    await db.insert(outboxEvents).values({
      id: poisonId,
      event_type: 'order.locked',
      topic: 'order.lifecycle',
      aggregate_id: 'x',
      payload: { not: 'a valid payload' },
      occurred_at: new Date(Date.now() - 60_000),
    });
    const valid = await enqueueLocked();
    const publisher = new RecordingPublisher();

    await new OutboxRelay(db, publisher, { maxAttempts: 1 }).runOnce();
    await drain(new OutboxRelay(db, publisher, { maxAttempts: 1 }));

    expect(publisher.published.map((e) => e.event_id)).toContain(valid.event_id);
    const [poison] = await rowsFor([poisonId]);
    expect(poison?.published_at).toBeNull();
    expect(poison?.publish_attempts).toBe(1);
    expect(poison?.last_error).toMatch(/invalid envelope/);
  });

  it('never publishes a row twice when several relays run concurrently (SKIP LOCKED)', async () => {
    const events = await Promise.all(Array.from({ length: 30 }, () => enqueueLocked()));
    const publisher = new RecordingPublisher();
    const relays = Array.from(
      { length: 4 },
      () => new OutboxRelay(db, publisher, { batchSize: 5 }),
    );

    await Promise.all(relays.map((relay) => drain(relay)));

    const ids = new Set(events.map((e) => e.event_id));
    const ours = publisher.published.filter((e) => ids.has(e.event_id));
    expect(ours).toHaveLength(30);
    expect(new Set(ours.map((e) => e.event_id)).size).toBe(30);
  });

  it('relays an event to Kafka through the idempotent producer (end-to-end)', async () => {
    const { producer, consumer } = await connectKafka(`relay-e2e-${randomUUID()}`);
    try {
      await consumer.subscribe({ topics: ['order.lifecycle'] });
      const event = await enqueueLocked();
      const received = new Promise<unknown>((resolve) => {
        void consumer.run({
          eachMessage: ({ message }) => {
            if (message.headers?.event_id?.toString() === event.event_id) {
              resolve(JSON.parse(message.value?.toString() ?? 'null'));
            }
            return Promise.resolve();
          },
        });
      });
      await awaitAssignment(consumer);

      await drain(new OutboxRelay(db, new DomainEventPublisher(producer)));

      await expect(within(received, 20_000, 'order.locked on Kafka')).resolves.toEqual(event);
      const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.event_id));
      expect(row?.published_at).not.toBeNull();
    } finally {
      await Promise.all([producer.disconnect(), consumer.disconnect()]);
    }
  }, 60_000);

  it('relays the vendor standing events to notifications.broadcast, keyed by vendor (Phase 12.5)', async () => {
    const { producer, consumer } = await connectKafka(`relay-vendor-${randomUUID()}`);
    try {
      await consumer.subscribe({ topics: ['notifications.broadcast'] });
      const vendorId = randomUUID();
      const at = new Date().toISOString();
      const suspended = await enqueueDomainEvent(db, {
        type: 'vendor.suspended_for_debt',
        aggregateId: vendorId,
        payload: {
          vendor_id: vendorId,
          vendor_phone: '+9779800000011',
          previous_status: 'LIVE',
          wallet_balance_npr: -2500,
          suspension_limit_npr: -2000,
          suspended_at: at,
        },
      });
      const restored = await enqueueDomainEvent(db, {
        type: 'vendor.restored',
        aggregateId: vendorId,
        payload: {
          vendor_id: vendorId,
          vendor_phone: '+9779800000011',
          restored_status: 'LIVE',
          wallet_balance_npr: 0,
          transaction_id: randomUUID(),
          restored_at: at,
        },
      });
      const wanted = new Set([suspended.event_id, restored.event_id]);
      const seen: { key: string | undefined; event: unknown }[] = [];
      const received = new Promise<void>((resolve) => {
        void consumer.run({
          eachMessage: ({ message }) => {
            if (wanted.has(message.headers?.event_id?.toString() ?? '')) {
              seen.push({
                key: message.key?.toString(),
                event: JSON.parse(message.value?.toString() ?? 'null'),
              });
              if (seen.length === wanted.size) resolve();
            }
            return Promise.resolve();
          },
        });
      });
      await awaitAssignment(consumer);

      await drain(new OutboxRelay(db, new DomainEventPublisher(producer)));
      await within(received, 20_000, 'vendor standing events on Kafka');

      // One key, so both land on one partition in order: suspended, then restored.
      expect(seen).toEqual([
        { key: vendorId, event: suspended },
        { key: vendorId, event: restored },
      ]);
    } finally {
      await Promise.all([producer.disconnect(), consumer.disconnect()]);
    }
  }, 60_000);
});

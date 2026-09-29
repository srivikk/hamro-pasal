import { randomUUID } from 'node:crypto';

import { createDatabase, enqueueDomainEvent, outboxEvents, type Database } from '@hamro-pasal/db';
import { createIdempotentProducer, createKafka, DomainEventPublisher } from '@hamro-pasal/kafka';
import { parseKafkaEnv, type DomainEvent } from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';

import { OutboxRelay, type EventPublisher } from '../src/outbox/outbox-relay';

/** Transactional outbox relay against real PostgreSQL (and, end-to-end, real Kafka). */
describe('OutboxRelay', () => {
  let db: Database;

  beforeAll(() => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 10 });
  });

  afterAll(async () => {
    await db.$client.end();
  });

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

  /** Runs the relay until the outbox has nothing left to publish. */
  async function drain(relay: OutboxRelay): Promise<void> {
    for (;;) {
      const result = await relay.runOnce();
      if (result.published + result.failed === 0) return;
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
    const kafka = createKafka(parseKafkaEnv(process.env));
    const producer = createIdempotentProducer(kafka);
    const consumer = kafka.consumer({
      kafkaJS: { groupId: `relay-e2e-${randomUUID()}`, fromBeginning: false },
    });
    await Promise.all([producer.connect(), consumer.connect()]);
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
      const deadline = Date.now() + 30_000;
      while (consumer.assignment().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await drain(new OutboxRelay(db, new DomainEventPublisher(producer)));

      await expect(received).resolves.toEqual(event);
      const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, event.event_id));
      expect(row?.published_at).not.toBeNull();
    } finally {
      await Promise.all([producer.disconnect(), consumer.disconnect()]);
    }
  }, 60_000);
});

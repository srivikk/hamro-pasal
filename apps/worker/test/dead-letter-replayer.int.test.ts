import { randomInt, randomUUID } from 'node:crypto';

import { createDatabase, deadLetterEvents, users, type Database } from '@hamro-pasal/db';
import { createIdempotentProducer, createKafka, type KafkaJS } from '@hamro-pasal/kafka';
import { KAFKA_TOPICS, parseKafkaEnv } from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';

import {
  KafkaDeadLetterPublisher,
  withDeadLetter,
  type DeadLetterPublisher,
} from '../src/consumers/dead-letter';
import { DeadLetterReplayer, replayRecord } from '../src/dead-letters/dead-letter-replayer';
import { DatabaseDeadLetterStore } from '../src/dead-letters/dead-letter-store';

/** A message read back from `notifications.broadcast`, headers decoded to strings. */
interface Republished {
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: Record<string, string>;
}

type NewRow = typeof deadLetterEvents.$inferInsert;

/**
 * Phase 15: the admin's "Retry" against real PostgreSQL and Kafka. The API only marks a row
 * RETRY_REQUESTED; DeadLetterReplayer republishes it to its source topic and marks it REPLAYED.
 */
describe('DeadLetterReplayer (dead_letter_events → Kafka source topic)', () => {
  let db: Database;
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let consumer: KafkaJS.Consumer;
  let adminId: string;
  const republished: Republished[] = [];
  const quiet = { onError: () => undefined, onReplayed: () => undefined };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    kafka = createKafka(parseKafkaEnv(process.env));
    producer = createIdempotentProducer(kafka);
    // A fresh group reading the topic from the start; tests filter by their own random keys.
    consumer = kafka.consumer({
      kafkaJS: { groupId: `dlq-replayer-int-${randomUUID()}`, fromBeginning: true },
    });
    await Promise.all([producer.connect(), consumer.connect()]);
    await consumer.subscribe({ topics: [KAFKA_TOPICS.NOTIFICATIONS_BROADCAST] });
    void consumer.run({
      eachMessage: ({ message }) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.headers ?? {})) {
          if (value !== undefined) headers[name] = value.toString();
        }
        republished.push({
          key: message.key?.toString() ?? null,
          value: message.value?.toString() ?? null,
          headers,
        });
        return Promise.resolve();
      },
    });
    await waitFor(() => consumer.assignment().length > 0, 30_000);

    const [admin] = await db
      .insert(users)
      .values({
        phone: `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`,
        role: 'SUPER_ADMIN',
      })
      .returning({ id: users.id });
    if (admin === undefined) throw new Error('admin not created');
    adminId = admin.id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all([producer.disconnect(), consumer.disconnect()]);
    await db.$client.end();
  });

  /** A stored dead letter of `notifications.broadcast` with a unique key. */
  async function deadLetter(overrides: Partial<NewRow> = {}) {
    const key = randomUUID();
    const eventId = randomUUID();
    const value = JSON.stringify({ event_id: eventId, event_type: 'vendor.restored' });
    const [row] = await db
      .insert(deadLetterEvents)
      .values({
        consumer: 'vendor-notifications',
        source_topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
        source_partition: 0,
        source_offset: String(randomInt(0, 1_000_000)),
        dead_letter_topic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
        message_key: Buffer.from(key),
        message_value: Buffer.from(value),
        headers: { event_id: eventId, event_type: 'vendor.restored', event_version: '1' },
        event_id: eventId,
        event_type: 'vendor.restored',
        attempts: 4,
        error_name: 'SmsDeliveryError',
        error_message: 'SPARROW SMS failed: HTTP 503',
        failed_at: new Date(),
        status: 'RETRY_REQUESTED',
        retry_requested_at: new Date(),
        retry_requested_by: adminId,
        ...overrides,
      })
      .returning();
    if (row === undefined) throw new Error('dead letter not created');
    return { row, key, value, eventId };
  }

  async function rowOf(id: string) {
    const [row] = await db.select().from(deadLetterEvents).where(eq(deadLetterEvents.id, id));
    if (row === undefined) throw new Error(`row ${id} vanished`);
    return row;
  }

  /** Drains every RETRY_REQUESTED row (this test file's and any left by others). */
  async function drain(replayer: DeadLetterReplayer): Promise<void> {
    for (;;) {
      const result = await replayer.runOnce();
      if (result.replayed + result.failed === 0) return;
    }
  }

  it('republishes a requested retry to its source topic byte for byte and marks it REPLAYED', async () => {
    const { row, key, value, eventId } = await deadLetter();
    const replayer = new DeadLetterReplayer(db, new KafkaDeadLetterPublisher(producer), quiet);

    await drain(replayer);

    await waitFor(() => republished.some((message) => message.key === key), 30_000);
    expect(republished.filter((message) => message.key === key)).toEqual([
      {
        key,
        value,
        headers: {
          event_id: eventId,
          event_type: 'vendor.restored',
          event_version: '1',
          dlq_replay_of: row.id,
        },
      },
    ]);
    const after = await rowOf(row.id);
    expect(after.status).toBe('REPLAYED');
    expect(after.replayed_at).toBeInstanceOf(Date);
    expect(after.replay_attempts).toBe(0);
  }, 60_000);

  it('leaves PENDING and already REPLAYED rows alone', async () => {
    const pending = await deadLetter({
      status: 'PENDING',
      retry_requested_at: null,
      retry_requested_by: null,
    });
    const replayed = await deadLetter({ status: 'REPLAYED', replayed_at: new Date() });
    const published: KafkaJS.ProducerRecord[] = [];
    const replayer = new DeadLetterReplayer(
      db,
      {
        publish: (record) => {
          published.push(record);
          return Promise.resolve();
        },
      },
      quiet,
    );

    await drain(replayer);

    const touched = published.map((record) => record.messages[0]?.key?.toString());
    expect(touched).not.toContain(pending.key);
    expect(touched).not.toContain(replayed.key);
    expect((await rowOf(pending.row.id)).status).toBe('PENDING');
  });

  it('keeps a row RETRY_REQUESTED with its error when Kafka refuses, and stops after maxAttempts', async () => {
    const { row } = await deadLetter();
    const refusing: DeadLetterPublisher = {
      publish: () => Promise.reject(new Error('broker down')),
    };
    const replayer = new DeadLetterReplayer(db, refusing, { ...quiet, maxAttempts: 2 });

    // Each pass fails once for every row it can still try.
    await replayer.runOnce();
    await replayer.runOnce();
    await replayer.runOnce();

    const after = await rowOf(row.id);
    expect(after.status).toBe('RETRY_REQUESTED');
    expect(after.replay_attempts).toBe(2);
    expect(after.last_replay_error).toBe('Error: broker down');
    expect(after.replayed_at).toBeNull();
  });

  it('publishes a row once when several replayers poll at the same time (row lock)', async () => {
    const { row } = await deadLetter();
    const published: string[] = [];
    const publisher: DeadLetterPublisher = {
      publish: async (record) => {
        await sleep(50);
        const replayOf = record.messages[0]?.headers?.dlq_replay_of;
        if (typeof replayOf === 'string') published.push(replayOf);
      },
    };
    const replayers = [1, 2, 3, 4].map(() => new DeadLetterReplayer(db, publisher, quiet));

    await Promise.all(replayers.map((replayer) => drain(replayer)));

    expect(published.filter((id) => id === row.id)).toEqual([row.id]);
    expect((await rowOf(row.id)).status).toBe('REPLAYED');
  });

  it('links a retry that fails again to the row it came from', async () => {
    const { row } = await deadLetter();
    // The replayed message reaches a consumer that still fails: it is dead-lettered again.
    const record = replayRecord(row);
    const message = record.messages[0];
    if (message === undefined) throw new Error('no message');
    const failingAgain = withDeadLetter(
      {
        topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
        handle: () => Promise.reject(new Error('SPARROW SMS failed: HTTP 503')),
      },
      {
        name: 'vendor-notifications',
        deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
        publisher: { publish: () => Promise.resolve() },
        store: new DatabaseDeadLetterStore(db),
        retryDelayMs: () => 0,
        onDeadLettered: () => undefined,
      },
    );
    const offset = String(randomInt(1_000_000, 2_000_000));
    await failingAgain.handle({
      topic: record.topic,
      partition: 1,
      message: {
        key: message.key === undefined || message.key === null ? null : Buffer.from(message.key),
        value: Buffer.from(message.value ?? ''),
        offset,
        timestamp: String(Date.now()),
        attributes: 0,
        headers: message.headers ?? {},
      },
      heartbeat: () => Promise.resolve(),
      pause: () => () => undefined,
    });

    const [again] = await db
      .select()
      .from(deadLetterEvents)
      .where(eq(deadLetterEvents.replay_of_id, row.id));
    expect(again).toMatchObject({
      status: 'PENDING',
      source_offset: offset,
      event_id: row.event_id,
      replay_of_id: row.id,
      // The link is a column, not a stored header.
      headers: row.headers,
    });
    expect(again?.message_value).toEqual(row.message_value);
  });

  it('stores a redelivered dead letter (same source offset) only once', async () => {
    const store = new DatabaseDeadLetterStore(db);
    const offset = String(randomInt(2_000_000, 3_000_000));
    const entry = {
      consumer: 'vendor-notifications',
      deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
      sourceTopic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
      partition: 1,
      offset,
      key: Buffer.from(randomUUID()),
      value: Buffer.from('{}'),
      headers: {},
      eventId: null,
      eventType: null,
      replayOfId: null,
      attempts: 1,
      errorName: 'PoisonMessageError',
      errorMessage: 'invalid envelope',
      failedAt: new Date(),
    };

    await Promise.all([store.save(entry), store.save(entry), store.save(entry)]);

    const rows = await db
      .select({ id: deadLetterEvents.id })
      .from(deadLetterEvents)
      .where(inArray(deadLetterEvents.source_offset, [offset]));
    expect(rows).toHaveLength(1);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(50);
  }
}

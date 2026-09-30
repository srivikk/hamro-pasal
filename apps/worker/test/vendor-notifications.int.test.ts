import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  enqueueDomainEvent,
  orders,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import { ivrGatewayFromEnv } from '@hamro-pasal/ivr';
import {
  createIdempotentProducer,
  createKafka,
  DomainEventPublisher,
  type KafkaJS,
} from '@hamro-pasal/kafka';
import {
  KAFKA_TOPICS,
  parseKafkaEnv,
  type DomainEvent,
  type OrderState,
} from '@hamro-pasal/shared-types';
import {
  smsGatewayFromEnv,
  SparrowSmsGateway,
  type FetchLike,
  type SmsDelivery,
  type SmsGateway,
  type SmsMessage,
} from '@hamro-pasal/sms';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { KafkaDeadLetterPublisher, withDeadLetter } from '../src/consumers/dead-letter';
import { RedisEventDeduplicator } from '../src/consumers/order-state-fanout';
import { vendorNotificationConsumer } from '../src/consumers/vendor-notifications';
import { DatabaseOrderStateReader } from '../src/notifications/order-state-reader';
import { OutboxRelay } from '../src/outbox/outbox-relay';

const SPARROW_URL = 'https://sparrow.test/v2/sms/';

interface SparrowRequest {
  readonly token: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly text: string | null;
}

/** A message read back from `notifications.dlq`, headers decoded to strings. */
interface DeadLetter {
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: Record<string, string>;
}

/**
 * Phases 13 and 14 against real infrastructure (pnpm infra:up):
 *   outbox row → OutboxRelay → Kafka `notifications.broadcast` → withDeadLetter(vendor-notifications)
 *   → the Sparrow adapter (its HTTP call captured by a fake fetch) + IVR_PROVIDER=MOCK,
 *   with the stale-order guard reading real PostgreSQL rows, and failures copied to the real
 *   `notifications.dlq` topic, read back by a second consumer.
 */
describe('vendor notifications (Kafka → SMS + IVR, stale-order guard, DLQ)', () => {
  let db: Database;
  let redis: Redis;
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let consumer: KafkaJS.Consumer;
  let dlqConsumer: KafkaJS.Consumer;

  /** Every POST the Sparrow adapter made. */
  const sparrowRequests: SparrowRequest[] = [];
  /** HTTP statuses Sparrow answers with next (default 200). */
  const sparrowStatuses: number[] = [];
  const sparrowFetch: FetchLike = (url, init) => {
    const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
    if (url === SPARROW_URL) {
      sparrowRequests.push({
        token: form.get('token'),
        from: form.get('from'),
        to: form.get('to'),
        text: form.get('text'),
      });
    }
    const status = sparrowStatuses.shift() ?? 200;
    return Promise.resolve(new Response(JSON.stringify({ response_code: status }), { status }));
  };
  const sparrow = new SparrowSmsGateway(
    { token: 'test-token', from: 'HamroPasal', apiUrl: SPARROW_URL },
    sparrowFetch,
  );
  /** The adapter the consumer sends through; a test may switch it (e.g. to MOCK). */
  let activeGateway: SmsGateway = sparrow;
  const delegatingGateway: SmsGateway = {
    provider: 'SPARROW',
    send: (message: SmsMessage): Promise<SmsDelivery> => activeGateway.send(message),
  };

  /** IVR_PROVIDER=MOCK, logging into this array instead of the console. */
  const ivrLines: string[] = [];
  const ivr = ivrGatewayFromEnv(
    { IVR_PROVIDER: 'MOCK' },
    { mockLog: (line) => ivrLines.push(line) },
  );

  /** Offsets the notification handler returned from (sent, dropped or dead-lettered). */
  const handled = new Set<string>();
  const deadLetters: DeadLetter[] = [];

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    redis = new Redis(process.env.TEST_REDIS_URL ?? '');
    kafka = createKafka(parseKafkaEnv(process.env));
    producer = createIdempotentProducer(kafka);
    consumer = kafka.consumer({
      kafkaJS: { groupId: `vendor-sms-int-${randomUUID()}`, fromBeginning: false },
    });
    dlqConsumer = kafka.consumer({
      kafkaJS: { groupId: `vendor-dlq-int-${randomUUID()}`, fromBeginning: false },
    });
    await Promise.all([producer.connect(), consumer.connect(), dlqConsumer.connect()]);

    const notifications = withDeadLetter(
      vendorNotificationConsumer({
        sms: delegatingGateway,
        smsDeduplicator: new RedisEventDeduplicator(redis, `test:${randomUUID()}:sms-seen:`),
        ivr,
        ivrDeduplicator: new RedisEventDeduplicator(redis, `test:${randomUUID()}:ivr-seen:`),
        orders: new DatabaseOrderStateReader(db),
        onSent: () => undefined,
      }),
      {
        name: 'vendor-notifications',
        deadLetterTopic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
        publisher: new KafkaDeadLetterPublisher(producer),
        retryDelayMs: () => 20,
        onDeadLettered: () => undefined,
      },
    );
    await consumer.subscribe({ topics: [notifications.topic] });
    void consumer.run({
      eachMessage: async (payload) => {
        await notifications.handle(payload);
        handled.add(`${String(payload.partition)}:${payload.message.offset}`);
        const eventId = payload.message.headers?.event_id?.toString();
        if (eventId !== undefined) handled.add(eventId);
      },
    });

    await dlqConsumer.subscribe({ topics: [KAFKA_TOPICS.NOTIFICATIONS_DLQ] });
    void dlqConsumer.run({
      eachMessage: ({ message }) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(message.headers ?? {})) {
          if (value !== undefined) headers[name] = value.toString();
        }
        deadLetters.push({
          key: message.key?.toString() ?? null,
          value: message.value?.toString() ?? null,
          headers,
        });
        return Promise.resolve();
      },
    });

    await waitFor(
      () => consumer.assignment().length > 0 && dlqConsumer.assignment().length > 0,
      30_000,
    );
    // A new group starts at the latest offset, fixed only once fetching begins: wait until a
    // warm-up message has gone through each consumer, so no test message lands before them.
    const warmUp = await enqueueRestored('+9779811111111');
    await relayOutbox();
    const dlqWarmUp = randomUUID();
    const deadline = Date.now() + 30_000;
    while (!handled.has(warmUp.event_id) || !deadLetters.some((d) => d.key === dlqWarmUp)) {
      if (Date.now() > deadline) throw new Error('Kafka consumers never started');
      await producer.send({
        topic: KAFKA_TOPICS.NOTIFICATIONS_DLQ,
        messages: [{ key: dlqWarmUp, value: 'warm-up' }],
      });
      await sleep(2_000);
      if (!handled.has(warmUp.event_id)) {
        await new DomainEventPublisher(producer).publish([warmUp]);
      }
    }
  }, 90_000);

  afterAll(async () => {
    await Promise.all([producer.disconnect(), consumer.disconnect(), dlqConsumer.disconnect()]);
    await redis.quit();
    await db.$client.end();
  });

  beforeEach(() => {
    activeGateway = sparrow;
    sparrowStatuses.length = 0;
  });

  function requestsTo(phone: string): SparrowRequest[] {
    return sparrowRequests.filter((request) => request.to === phone);
  }

  function callsTo(phone: string): string[] {
    return ivrLines.filter((line) => line.startsWith(`[ivr:mock] Calling ${phone}:`));
  }

  function deadLettersFor(key: string): DeadLetter[] {
    return deadLetters.filter((letter) => letter.key === key);
  }

  /** A fresh +977 number per test, so assertions only see their own SMS and calls. */
  function freshPhone(): string {
    return `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  }

  async function relayOutbox(): Promise<void> {
    const relay = new OutboxRelay(db, new DomainEventPublisher(producer));
    for (;;) {
      const result = await relay.runOnce();
      if (result.published + result.failed === 0) return;
    }
  }

  async function user(role: 'CUSTOMER' | 'VENDOR'): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({ phone: freshPhone(), role })
      .returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  /** A LIVE vendor with this phone and an order of theirs PLACED 91 s ago. */
  async function placedOrder(vendorPhone: string): Promise<{ orderId: string; vendorId: string }> {
    const [vendor] = await db
      .insert(vendors)
      .values({
        user_id: await user('VENDOR'),
        business_name: 'Thamel Kirana Pasal',
        phone: vendorPhone,
        status: 'LIVE',
        pricing_model: 'COMMISSION',
        commission_rate: 0.1,
        delivery_scope: 'RADIUS_BOUND',
        fulfillment_mode: 'SELF_DELIVERY',
        radius_km: 5,
        municipality_palika_string: 'Kathmandu Metropolitan City',
        min_order_value: 0,
        base_delivery_fee_npr: 50,
        location: { x: 85.3123, y: 27.7154 },
      })
      .returning({ id: vendors.id });
    if (vendor === undefined) throw new Error('vendor not created');
    const [order] = await db
      .insert(orders)
      .values({
        idempotency_key: randomUUID(),
        customer_id: await user('CUSTOMER'),
        vendor_id: vendor.id,
        state: 'PLACED',
        placed_at: sql`now() - interval '91 seconds'`,
        subtotal: 1000,
        delivery_fee: 50,
        platform_commission_amount: 100,
        fulfillment_locked: 'SELF_DELIVERY',
        payment_method: 'COD',
        delivery_otp: '$2b$10$abcdefghijklmnopqrstuuM3bJ0n9ZkZ2p9Y5o0t7m6c1QwV8e2yG',
      })
      .returning({ id: orders.id });
    if (order === undefined) throw new Error('order not created');
    return { orderId: order.id, vendorId: vendor.id };
  }

  async function setState(orderId: string, state: OrderState): Promise<void> {
    await db.update(orders).set({ state }).where(eq(orders.id, orderId));
  }

  function enqueueSuspended(phone: string, vendorId: string = randomUUID()): Promise<DomainEvent> {
    return enqueueDomainEvent(db, {
      type: 'vendor.suspended_for_debt',
      aggregateId: vendorId,
      payload: {
        vendor_id: vendorId,
        vendor_phone: phone,
        previous_status: 'LIVE',
        wallet_balance_npr: -2500,
        suspension_limit_npr: -2000,
        suspended_at: new Date().toISOString(),
      },
    });
  }

  function enqueueRestored(phone: string, vendorId: string = randomUUID()): Promise<DomainEvent> {
    return enqueueDomainEvent(db, {
      type: 'vendor.restored',
      aggregateId: vendorId,
      payload: {
        vendor_id: vendorId,
        vendor_phone: phone,
        restored_status: 'LIVE',
        wallet_balance_npr: 0,
        transaction_id: randomUUID(),
        restored_at: new Date().toISOString(),
      },
    });
  }

  function enqueueEscalation(
    phone: string,
    order: { orderId: string; vendorId: string },
  ): Promise<DomainEvent> {
    return enqueueDomainEvent(db, {
      type: 'vendor.escalation.required',
      aggregateId: order.orderId,
      payload: {
        order_id: order.orderId,
        vendor_id: order.vendorId,
        vendor_phone: phone,
        placed_at: new Date(Date.now() - 91_000).toISOString(),
        sla_seconds: 90,
        escalated_at: new Date().toISOString(),
      },
    });
  }

  it('pulls each event type from Kafka and sends its template through Sparrow', async () => {
    const suspendedPhone = freshPhone();
    const restoredPhone = freshPhone();
    const escalationPhone = freshPhone();
    const order = await placedOrder(escalationPhone);

    await enqueueSuspended(suspendedPhone);
    await enqueueRestored(restoredPhone);
    await enqueueEscalation(escalationPhone, order);
    await relayOutbox();

    await waitFor(
      () =>
        requestsTo(suspendedPhone).length +
          requestsTo(restoredPhone).length +
          requestsTo(escalationPhone).length ===
        3,
      30_000,
    );
    expect(requestsTo(suspendedPhone)).toEqual([
      {
        token: 'test-token',
        from: 'HamroPasal',
        to: suspendedPhone,
        text:
          'Hamro Pasal: your shop is offline. Your wallet is at Rs. -2,500, below the Rs. -2,000 ' +
          "limit. Pay Rs. 2,500 in the app's Wallet to go back online.",
      },
    ]);
    expect(requestsTo(restoredPhone).map((request) => request.text)).toEqual([
      'Hamro Pasal: your dues are cleared and your shop is back online. Wallet balance: Rs. 0.',
    ]);
    const code = order.orderId.replace(/-/g, '').slice(-6).toUpperCase();
    expect(requestsTo(escalationPhone).map((request) => request.text)).toEqual([
      `Hamro Pasal: order #${code} has waited over 90 seconds. Open the app now to accept or reject it.`,
    ]);
    // Only the escalation also phones the vendor (IVR_PROVIDER=MOCK logs the call).
    expect(callsTo(escalationPhone)).toEqual([
      `[ivr:mock] Calling ${escalationPhone}: "You have a pending order on Hamro Pasal. Order ` +
        `${code.split('').join(' ')} has waited over 90 seconds. Open the app now to accept or reject it."`,
    ]);
    expect(callsTo(suspendedPhone)).toEqual([]);
    expect(callsTo(restoredPhone)).toEqual([]);
  }, 60_000);

  it('texts a redelivered event (same event_id) only once', async () => {
    const phone = freshPhone();
    const event = await enqueueSuspended(phone);
    await relayOutbox();
    await waitFor(() => requestsTo(phone).length === 1, 30_000);

    // At-least-once delivery: the same envelope reaches the topic again, then a marker after it.
    await new DomainEventPublisher(producer).publish([event]);
    const marker = await enqueueRestored(phone);
    await relayOutbox();
    await waitFor(() => handled.has(marker.event_id), 30_000);

    expect(requestsTo(phone).map((request) => request.text?.slice(0, 34))).toEqual([
      'Hamro Pasal: your shop is offline.',
      'Hamro Pasal: your dues are cleared',
    ]);
  }, 60_000);

  it('retries a message Sparrow refused, and the vendor gets it once', async () => {
    const phone = freshPhone();
    sparrowStatuses.push(503);

    const order = await placedOrder(phone);
    const event = await enqueueEscalation(phone, order);
    await relayOutbox();

    // Attempt 1 is recorded (then refused with HTTP 503), attempt 2 is accepted.
    await waitFor(() => handled.has(event.event_id), 45_000);
    expect(requestsTo(phone)).toHaveLength(2);
    expect(sparrowStatuses).toEqual([]);
    // The call went out on the first attempt and was not repeated by the retry.
    expect(callsTo(phone)).toHaveLength(1);
    expect(deadLettersFor(order.orderId)).toEqual([]);
  }, 60_000);

  describe('stale-order guard', () => {
    it.each<[string, OrderState]>([
      ['accepted (PREPARING)', 'PREPARING'],
      ['rejected or canceled (CANCELED)', 'CANCELED'],
    ])(
      'drops the escalation of an order %s before the event was consumed',
      async (_label, state) => {
        const phone = freshPhone();
        const order = await placedOrder(phone);
        const event = await enqueueEscalation(phone, order);
        // The vendor answers after the 90 s timer wrote the event but before it is consumed.
        await setState(order.orderId, state);
        await relayOutbox();

        await waitFor(() => handled.has(event.event_id), 30_000);
        expect(requestsTo(phone)).toEqual([]);
        expect(callsTo(phone)).toEqual([]);
        expect(deadLettersFor(order.orderId)).toEqual([]);
      },
      60_000,
    );

    it('still notifies about an order that is PLACED when the event is consumed', async () => {
      const phone = freshPhone();
      const order = await placedOrder(phone);
      const event = await enqueueEscalation(phone, order);
      await relayOutbox();

      await waitFor(() => handled.has(event.event_id), 30_000);
      expect(requestsTo(phone)).toHaveLength(1);
      expect(callsTo(phone)).toHaveLength(1);
    }, 60_000);
  });

  describe('dead-letter queue', () => {
    it('routes an event to notifications.dlq after 3 failed retries and moves on', async () => {
      const phone = freshPhone();
      const vendorId = randomUUID();
      // Persistent outage: the first attempt and all 3 retries get HTTP 503.
      sparrowStatuses.push(503, 503, 503, 503);

      const failed = await enqueueSuspended(phone, vendorId);
      // Same key → same partition, queued behind the failing event.
      const next = await enqueueRestored(phone, vendorId);
      await relayOutbox();

      await waitFor(() => handled.has(next.event_id), 45_000);
      await waitFor(() => deadLettersFor(vendorId).length === 1, 30_000);

      // 1 attempt + 3 retries, then the next message on the partition is texted.
      expect(requestsTo(phone).map((request) => request.text?.slice(0, 34))).toEqual([
        'Hamro Pasal: your shop is offline.',
        'Hamro Pasal: your shop is offline.',
        'Hamro Pasal: your shop is offline.',
        'Hamro Pasal: your shop is offline.',
        'Hamro Pasal: your dues are cleared',
      ]);
      const [letter] = deadLettersFor(vendorId);
      expect(JSON.parse(letter?.value ?? 'null')).toEqual(failed);
      expect(letter?.headers).toMatchObject({
        event_id: failed.event_id,
        event_type: 'vendor.suspended_for_debt',
        dlq_source_topic: 'notifications.broadcast',
        dlq_consumer: 'vendor-notifications',
        dlq_attempts: '4',
        dlq_error_name: 'SmsDeliveryError',
        dlq_error_message: 'SPARROW SMS failed: HTTP 503',
      });
      expect(letter?.headers.dlq_source_offset).toMatch(/^\d+$/);
      // The offset was committed: no further attempt arrives.
      await sleep(1_000);
      expect(requestsTo(phone)).toHaveLength(5);
    }, 90_000);

    it('does not dead-letter an event that succeeds on its 3rd retry', async () => {
      const phone = freshPhone();
      const vendorId = randomUUID();
      sparrowStatuses.push(503, 503, 503);

      const event = await enqueueSuspended(phone, vendorId);
      await relayOutbox();

      await waitFor(() => handled.has(event.event_id), 45_000);
      expect(requestsTo(phone)).toHaveLength(4);
      await sleep(1_000);
      expect(deadLettersFor(vendorId)).toEqual([]);
    }, 60_000);

    it('dead-letters a poison pill at once, byte for byte, and processes the next message', async () => {
      const phone = freshPhone();
      const vendorId = randomUUID();
      const poison = '{"event_type":"vendor.restored","payload":{}}';

      await producer.send({
        topic: KAFKA_TOPICS.NOTIFICATIONS_BROADCAST,
        messages: [{ key: vendorId, value: poison }],
      });
      const next = await enqueueRestored(phone, vendorId);
      await relayOutbox();

      await waitFor(() => handled.has(next.event_id), 30_000);
      await waitFor(() => deadLettersFor(vendorId).length === 1, 30_000);
      expect(requestsTo(phone)).toHaveLength(1);
      const [letter] = deadLettersFor(vendorId);
      expect(letter?.value).toBe(poison);
      expect(letter?.headers).toMatchObject({
        dlq_attempts: '1',
        dlq_error_name: 'PoisonMessageError',
      });
      expect(letter?.headers.dlq_error_message).toMatch(
        /^invalid envelope at partition \d offset \d+$/,
      );
    }, 60_000);
  });

  it('SMS_PROVIDER=MOCK logs the body and makes no network call', async () => {
    const phone = freshPhone();
    const lines: string[] = [];
    activeGateway = smsGatewayFromEnv(
      {
        SMS_PROVIDER: 'MOCK',
        SPARROW_SMS_TOKEN: undefined,
        SPARROW_SMS_FROM: undefined,
        SPARROW_SMS_API_URL: undefined,
        AAKASH_SMS_AUTH_TOKEN: undefined,
        AAKASH_SMS_API_URL: undefined,
      },
      { mockLog: (line) => lines.push(line), fetch: sparrowFetch },
    );

    const event = await enqueueRestored(phone);
    await relayOutbox();
    await waitFor(() => handled.has(event.event_id), 30_000);

    expect(lines).toEqual([
      `[sms:mock] to ${phone}: Hamro Pasal: your dues are cleared and your shop is back online. Wallet balance: Rs. 0.`,
    ]);
    expect(requestsTo(phone)).toEqual([]);
  }, 60_000);
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

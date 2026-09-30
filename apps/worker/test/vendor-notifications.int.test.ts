import { randomUUID } from 'node:crypto';

import { createDatabase, enqueueDomainEvent, type Database } from '@hamro-pasal/db';
import {
  createIdempotentProducer,
  createKafka,
  DomainEventPublisher,
  type KafkaJS,
} from '@hamro-pasal/kafka';
import { parseKafkaEnv, type DomainEvent } from '@hamro-pasal/shared-types';
import {
  smsGatewayFromEnv,
  SparrowSmsGateway,
  type FetchLike,
  type SmsDelivery,
  type SmsGateway,
  type SmsMessage,
} from '@hamro-pasal/sms';
import { Redis } from 'ioredis';

import { RedisEventDeduplicator } from '../src/consumers/order-state-fanout';
import { vendorNotificationConsumer } from '../src/consumers/vendor-notifications';
import { OutboxRelay } from '../src/outbox/outbox-relay';

const SPARROW_URL = 'https://sparrow.test/v2/sms/';

interface SparrowRequest {
  readonly token: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly text: string | null;
}

/**
 * Phase 13 against real infrastructure (pnpm infra:up):
 *   outbox row → OutboxRelay → Kafka `notifications.broadcast` → vendor-notifications consumer
 *   → the Sparrow adapter (its HTTP call captured by a fake fetch) or SMS_PROVIDER=MOCK.
 */
describe('vendor notification SMS (Kafka → SMS adapter)', () => {
  let db: Database;
  let redis: Redis;
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let consumer: KafkaJS.Consumer;

  /** Every POST the Sparrow adapter made, by recipient. */
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

  const handled = new Set<string>();

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    redis = new Redis(process.env.TEST_REDIS_URL ?? '');
    kafka = createKafka(parseKafkaEnv(process.env));
    producer = createIdempotentProducer(kafka);
    consumer = kafka.consumer({
      kafkaJS: { groupId: `vendor-sms-int-${randomUUID()}`, fromBeginning: false },
    });
    await Promise.all([producer.connect(), consumer.connect()]);

    const notifications = vendorNotificationConsumer({
      sms: delegatingGateway,
      deduplicator: new RedisEventDeduplicator(redis, `test:${randomUUID()}:sms-seen:`),
      onInvalidMessage: () => undefined,
      onSent: () => undefined,
    });
    await consumer.subscribe({ topics: [notifications.topic] });
    void consumer.run({
      eachMessage: async (payload) => {
        await notifications.handle(payload);
        const eventId = payload.message.headers?.event_id?.toString();
        if (eventId !== undefined) handled.add(eventId);
      },
    });
    await waitFor(() => consumer.assignment().length > 0, 30_000);
    // A new group starts at the latest offset, fixed only once fetching begins: wait until a
    // warm-up event has gone through, so no test event lands before the consumer's position.
    const warmUp = await enqueueRestored('+9779811111111');
    await relayOutbox();
    const deadline = Date.now() + 30_000;
    while (!handled.has(warmUp.event_id)) {
      if (Date.now() > deadline) throw new Error('Kafka consumer never started');
      await sleep(2_000).then(() => new DomainEventPublisher(producer).publish([warmUp]));
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all([producer.disconnect(), consumer.disconnect()]);
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

  /** A fresh +977 number per test, so assertions only see their own SMS. */
  function freshPhone(): string {
    return `+9779${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
  }

  async function relayOutbox(): Promise<void> {
    const relay = new OutboxRelay(db, new DomainEventPublisher(producer));
    for (;;) {
      const result = await relay.runOnce();
      if (result.published + result.failed === 0) return;
    }
  }

  function enqueueSuspended(phone: string): Promise<DomainEvent> {
    const vendorId = randomUUID();
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

  function enqueueRestored(phone: string): Promise<DomainEvent> {
    const vendorId = randomUUID();
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

  function enqueueEscalation(phone: string, orderId: string): Promise<DomainEvent> {
    return enqueueDomainEvent(db, {
      type: 'vendor.escalation.required',
      aggregateId: orderId,
      payload: {
        order_id: orderId,
        vendor_id: randomUUID(),
        vendor_phone: phone,
        placed_at: new Date(Date.now() - 90_000).toISOString(),
        sla_seconds: 90,
        escalated_at: new Date().toISOString(),
      },
    });
  }

  it('pulls each event type from Kafka and sends its template through Sparrow', async () => {
    const suspendedPhone = freshPhone();
    const restoredPhone = freshPhone();
    const escalationPhone = freshPhone();
    const orderId = 'a1b2c3d4-0000-4000-8000-00000000beef';

    await enqueueSuspended(suspendedPhone);
    await enqueueRestored(restoredPhone);
    await enqueueEscalation(escalationPhone, orderId);
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
    expect(requestsTo(escalationPhone).map((request) => request.text)).toEqual([
      'Hamro Pasal: order #00BEEF has waited over 90 seconds. Open the app now to accept or reject it.',
    ]);
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

    await enqueueEscalation(phone, randomUUID());
    await relayOutbox();

    // Attempt 1 is recorded (then refused with HTTP 503), attempt 2 is accepted.
    await waitFor(() => requestsTo(phone).length === 2, 45_000);
    await sleep(500);
    expect(requestsTo(phone)).toHaveLength(2);
    expect(sparrowStatuses).toEqual([]);
  }, 60_000);

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

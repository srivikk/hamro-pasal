import { randomInt, randomUUID } from 'node:crypto';

import {
  createDatabase,
  deviceTokens,
  enqueueDomainEvent,
  users,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  createIdempotentProducer,
  createKafka,
  DomainEventPublisher,
  type KafkaJS,
} from '@hamro-pasal/kafka';
import {
  orderPushDataSchema,
  parseKafkaEnv,
  type DomainEvent,
  type OrderState,
} from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';

import { orderPushNotificationConsumer } from '../src/consumers/order-push-notifications';
import { RedisEventDeduplicator } from '../src/consumers/order-state-fanout';
import { DatabasePushRecipients } from '../src/notifications/push-recipients';
import { OutboxRelay } from '../src/outbox/outbox-relay';
import { ExpoPushGateway, type FetchLike } from '../src/push/expo-push';

interface ExpoMessage {
  readonly to: string;
  readonly title?: string;
  readonly body?: string;
  readonly priority?: string;
  readonly channelId?: string;
  readonly _contentAvailable?: boolean;
  readonly data: unknown;
}

/**
 * Phase 20 against real infrastructure (pnpm infra:up):
 *   outbox row → OutboxRelay → Kafka `order.lifecycle` → order-push consumer
 *   → device_tokens / users / vendors rows in PostgreSQL → the Expo push gateway, whose HTTP call
 *   to exp.host is captured by a fake fetch (no request leaves the machine).
 */
describe('order push notifications (Kafka → device_tokens → Expo push API)', () => {
  let db: Database;
  let redis: Redis;
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let consumer: KafkaJS.Consumer;

  /** Every request the gateway made: its URL and the messages in its body. */
  const expoRequests: { url: string; messages: ExpoMessage[] }[] = [];
  /** Tokens the fake Expo reports as DeviceNotRegistered. */
  const unregistered = new Set<string>();
  /** HTTP statuses Expo answers with next (default 200). */
  const expoStatuses: number[] = [];
  const expoFetch: FetchLike = (url, init) => {
    const messages = JSON.parse(typeof init.body === 'string' ? init.body : '[]') as ExpoMessage[];
    expoRequests.push({ url, messages });
    const status = expoStatuses.shift() ?? 200;
    if (status !== 200) return Promise.resolve(new Response('unavailable', { status }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: messages.map(({ to }) =>
            unregistered.has(to)
              ? {
                  status: 'error',
                  message: `"${to}" is not a registered push notification recipient`,
                  details: { error: 'DeviceNotRegistered' },
                }
              : { status: 'ok', id: randomUUID() },
          ),
        }),
        { status: 200 },
      ),
    );
  };

  /** The `[sms:mock]` lines logged beside the pushes (SMS_PROVIDER=MOCK). */
  const smsLines: string[] = [];
  /** Event ids the consumer returned from. */
  const handled = new Set<string>();

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    redis = new Redis(process.env.TEST_REDIS_URL ?? '');
    kafka = createKafka(parseKafkaEnv(process.env));
    producer = createIdempotentProducer(kafka);
    consumer = kafka.consumer({
      kafkaJS: { groupId: `order-push-int-${randomUUID()}`, fromBeginning: false },
    });
    await Promise.all([producer.connect(), consumer.connect()]);

    const recipients = new DatabasePushRecipients(db);
    const push = orderPushNotificationConsumer({
      recipients,
      tokens: recipients,
      push: new ExpoPushGateway({ fetch: expoFetch }),
      deduplicator: new RedisEventDeduplicator(redis, `test:${randomUUID()}:push-seen:`),
      smsFallbackLog: (line) => smsLines.push(line),
      onOutcome: () => undefined,
    });
    await consumer.subscribe({ topics: [push.topic] });
    void consumer.run({
      eachMessage: async (payload) => {
        await push.handle(payload);
        const eventId = payload.message.headers?.event_id?.toString();
        if (eventId !== undefined) handled.add(eventId);
      },
    });
    await waitFor(() => consumer.assignment().length > 0, 30_000);
    // A new group starts at the latest offset, fixed only once fetching begins: wait until a
    // warm-up event has gone through, so no test event can land before the consumer's position.
    const warmUp = await enqueueStateChange(await order(), 'PREPARING');
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
    expoStatuses.length = 0;
  });

  const freshPhone = () => `+9779${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
  const freshToken = () => `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;

  async function user(role: 'CUSTOMER' | 'VENDOR', phone = freshPhone()): Promise<string> {
    const [row] = await db.insert(users).values({ phone, role }).returning({ id: users.id });
    if (row === undefined) throw new Error('user not created');
    return row.id;
  }

  async function device(userId: string, platform: 'ANDROID' | 'IOS' = 'ANDROID'): Promise<string> {
    const token = freshToken();
    await db.insert(deviceTokens).values({ user_id: userId, token, platform });
    return token;
  }

  interface OrderParties {
    readonly orderId: string;
    readonly customerId: string;
    readonly customerPhone: string;
    readonly vendorId: string;
    readonly vendorUserId: string;
    readonly vendorPhone: string;
  }

  /** A customer and a vendor (with its own user) in PostgreSQL, and the id of an order of theirs. */
  async function order(): Promise<OrderParties> {
    const customerPhone = freshPhone();
    const vendorPhone = freshPhone();
    const vendorUserId = await user('VENDOR');
    const [vendor] = await db
      .insert(vendors)
      .values({
        user_id: vendorUserId,
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
    return {
      orderId: randomUUID(),
      customerId: await user('CUSTOMER', customerPhone),
      customerPhone,
      vendorId: vendor.id,
      vendorUserId,
      vendorPhone,
    };
  }

  function enqueueStateChange(
    parties: OrderParties,
    toState: OrderState,
    fromState: OrderState = 'PLACED',
  ): Promise<DomainEvent> {
    return enqueueDomainEvent(db, {
      type: 'order.state_changed',
      aggregateId: parties.orderId,
      payload: {
        order_id: parties.orderId,
        customer_id: parties.customerId,
        vendor_id: parties.vendorId,
        from_state: fromState,
        to_state: toState,
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: new Date(Date.now() - 30_000).toISOString(),
        delivered_at: null,
        changed_at: new Date().toISOString(),
      },
    });
  }

  async function relayOutbox(): Promise<void> {
    const relay = new OutboxRelay(db, new DomainEventPublisher(producer));
    for (;;) {
      const result = await relay.runOnce();
      if (result.published + result.failed === 0) return;
    }
  }

  /** Publishes the event through the outbox and waits until the consumer has handled it. */
  async function consume(event: DomainEvent): Promise<void> {
    await relayOutbox();
    await waitFor(() => handled.has(event.event_id), 30_000);
  }

  function messagesTo(...tokens: string[]): ExpoMessage[] {
    return expoRequests.flatMap((request) =>
      request.messages.filter((message) => tokens.includes(message.to)),
    );
  }

  const codeOf = (orderId: string) => orderId.replace(/-/g, '').slice(-6).toUpperCase();

  it('pushes a new order to every device of the vendor, data-only, through exp.host', async () => {
    const parties = await order();
    const shopPhone = await device(parties.vendorUserId);
    const shopTablet = await device(parties.vendorUserId, 'IOS');
    const customerDevice = await device(parties.customerId);

    const event = await enqueueStateChange(parties, 'PLACED', 'PENDING_PAYMENT');
    await consume(event);

    const request = expoRequests.find((r) => r.messages.some((m) => m.to === shopPhone));
    expect(request?.url).toBe('https://exp.host/--/api/v2/push/send');
    const data = {
      type: 'order.state_changed',
      notification_id: event.event_id,
      order_id: parties.orderId,
      state: 'PLACED',
      audience: 'VENDOR',
      data_only: true,
      title: 'New order',
      body: `Order #${codeOf(parties.orderId)} is waiting. Open the app to accept or reject it.`,
    };
    expect(request?.messages).toEqual([
      { to: shopPhone, priority: 'high', _contentAvailable: true, data },
      { to: shopTablet, priority: 'high', _contentAvailable: true, data },
    ]);
    expect(orderPushDataSchema.safeParse(request?.messages[0]?.data).success).toBe(true);
    // The customer placed it: nothing is sent to them.
    expect(messagesTo(customerDevice)).toEqual([]);
  }, 60_000);

  it('pushes an acceptance to the customer as a visible notification', async () => {
    const parties = await order();
    const customerDevice = await device(parties.customerId);
    const shopDevice = await device(parties.vendorUserId);

    await consume(await enqueueStateChange(parties, 'PREPARING'));

    expect(messagesTo(customerDevice, shopDevice)).toMatchObject([
      {
        to: customerDevice,
        title: 'Order accepted',
        body: `The shop is preparing order #${codeOf(parties.orderId)}.`,
        priority: 'high',
        channelId: 'orders',
        data: { state: 'PREPARING', audience: 'CUSTOMER', order_id: parties.orderId },
      },
    ]);
  }, 60_000);

  it('pushes a cancellation to both sides', async () => {
    const parties = await order();
    const customerDevice = await device(parties.customerId);
    const shopDevice = await device(parties.vendorUserId);

    await consume(await enqueueStateChange(parties, 'CANCELED'));

    expect(messagesTo(customerDevice, shopDevice).map((m) => [m.to, m.title])).toEqual([
      [customerDevice, 'Order cancelled'],
      [shopDevice, 'Order cancelled'],
    ]);
  }, 60_000);

  it('logs the mock SMS beside the push, also for a recipient without a device', async () => {
    const parties = await order();
    const shopDevice = await device(parties.vendorUserId);
    const requestsBefore = expoRequests.length;

    await consume(await enqueueStateChange(parties, 'PLACED', 'PENDING_PAYMENT'));
    await consume(await enqueueStateChange(parties, 'PREPARING'));

    const code = codeOf(parties.orderId);
    expect(smsLines).toContain(
      `[sms:mock] to ${parties.vendorPhone}: Hamro Pasal: New order. Order #${code} is waiting. Open the app to accept or reject it.`,
    );
    // The customer has no device: no push request, but the SMS it stands in for is logged.
    expect(smsLines).toContain(
      `[sms:mock] to ${parties.customerPhone}: Hamro Pasal: Order accepted. The shop is preparing order #${code}.`,
    );
    expect(expoRequests.slice(requestsBefore).flatMap((r) => r.messages.map((m) => m.to))).toEqual([
      shopDevice,
    ]);
  }, 60_000);

  it('sends a redelivered event (same event_id) only once', async () => {
    const parties = await order();
    const customerDevice = await device(parties.customerId);
    const event = await enqueueStateChange(parties, 'PREPARING');
    await consume(event);

    // At-least-once delivery: the same envelope reaches the topic again.
    await new DomainEventPublisher(producer).publish([event]);
    await consume(await enqueueStateChange(parties, 'OUT_FOR_DELIVERY', 'PREPARING'));

    expect(messagesTo(customerDevice).map((m) => (m.data as { state: string }).state)).toEqual([
      'PREPARING',
      'OUT_FOR_DELIVERY',
    ]);
  }, 60_000);

  it('deletes a token Expo reports as DeviceNotRegistered and keeps the others', async () => {
    const parties = await order();
    const oldPhone = await device(parties.customerId);
    const newPhone = await device(parties.customerId);
    unregistered.add(oldPhone);

    await consume(await enqueueStateChange(parties, 'PREPARING'));

    await waitForAsync(async () => {
      const rows = await db
        .select({ token: deviceTokens.token })
        .from(deviceTokens)
        .where(eq(deviceTokens.user_id, parties.customerId));
      return rows.length === 1 && rows[0]?.token === newPhone;
    }, 10_000);
    expect(messagesTo(oldPhone, newPhone)).toHaveLength(2);
  }, 60_000);

  it('moves on when Expo is down: the next event on the partition is still pushed', async () => {
    const parties = await order();
    const customerDevice = await device(parties.customerId);
    expoStatuses.push(503);

    await consume(await enqueueStateChange(parties, 'PREPARING'));
    // Same order id = same Kafka key = same partition.
    await consume(await enqueueStateChange(parties, 'OUT_FOR_DELIVERY', 'PREPARING'));

    const states = messagesTo(customerDevice).map((m) => (m.data as { state: string }).state);
    // The refused request was made once (not retried); the following event went out.
    expect(states).toEqual(['PREPARING', 'OUT_FOR_DELIVERY']);
    expect(
      await db
        .select()
        .from(deviceTokens)
        .where(inArray(deviceTokens.token, [customerDevice])),
    ).toHaveLength(1);
  }, 60_000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  await waitForAsync(() => Promise.resolve(condition()), timeoutMs);
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await sleep(50);
  }
}

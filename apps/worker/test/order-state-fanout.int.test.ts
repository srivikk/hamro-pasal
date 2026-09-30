import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDatabase, enqueueDomainEvent, type Database } from '@hamro-pasal/db';
import {
  createIdempotentProducer,
  createKafka,
  DomainEventPublisher,
  type KafkaJS,
} from '@hamro-pasal/kafka';
import {
  orderRoom,
  orderStateUpdateSchema,
  parseKafkaEnv,
  type DomainEvent,
  type OrderStateUpdate,
} from '@hamro-pasal/shared-types';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';

import {
  orderStateFanoutConsumer,
  RedisEventDeduplicator,
  RedisOrderRoomBroadcaster,
} from '../src/consumers/order-state-fanout';
import { OutboxRelay } from '../src/outbox/outbox-relay';

/**
 * End-to-end fan-out against real infrastructure (pnpm infra:up):
 *   outbox row → OutboxRelay → Kafka `order.lifecycle` → order-state-fanout consumer
 *   → Redis (socket.io emitter) → Socket.io server with @socket.io/redis-adapter → client in the
 *   `order:{id}` room.
 * The Socket.io server here stands in for the API process: it uses the same adapter and joins each
 * client to the room named in its handshake (the API checks ownership first; tested in apps/api).
 */
describe('order state fan-out (Kafka → Redis room)', () => {
  // Redis pub/sub channels are not scoped by logical DB: a unique key isolates this run.
  const key = `test:${randomUUID()}:socket.io`;
  let db: Database;
  let redis: Redis;
  let pub: Redis;
  let sub: Redis;
  let httpServer: HttpServer;
  let io: Server;
  let url: string;
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let consumer: KafkaJS.Consumer;
  const clients: ClientSocket[] = [];
  let failNextBroadcast = false;

  beforeAll(async () => {
    const redisUrl = process.env.TEST_REDIS_URL ?? '';
    db = createDatabase(process.env.TEST_DATABASE_URL ?? '', { max: 5 });
    redis = new Redis(redisUrl);
    pub = new Redis(redisUrl);
    sub = pub.duplicate();

    httpServer = createServer();
    io = new Server(httpServer, { transports: ['websocket'] });
    io.adapter(createAdapter(pub, sub, { key }));
    io.of('/orders').on('connection', (socket) => {
      const auth: unknown = socket.handshake.auth;
      const orderId: unknown =
        typeof auth === 'object' && auth !== null ? Reflect.get(auth, 'order_id') : undefined;
      if (typeof orderId === 'string') void socket.join(orderRoom(orderId));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;

    kafka = createKafka(parseKafkaEnv(process.env));
    producer = createIdempotentProducer(kafka);
    consumer = kafka.consumer({
      kafkaJS: { groupId: `order-fanout-int-${randomUUID()}`, fromBeginning: false },
    });
    await Promise.all([producer.connect(), consumer.connect()]);

    const broadcaster = new RedisOrderRoomBroadcaster(redis, key);
    const fanout = orderStateFanoutConsumer({
      broadcaster: {
        broadcast: (update, rooms) => {
          if (failNextBroadcast) {
            failNextBroadcast = false;
            return Promise.reject(new Error('simulated Redis outage'));
          }
          return broadcaster.broadcast(update, rooms);
        },
      },
      deduplicator: new RedisEventDeduplicator(redis, `test:${randomUUID()}:seen:`),
      onInvalidMessage: () => undefined,
    });
    const handled = new Set<string>();
    await consumer.subscribe({ topics: [fanout.topic] });
    void consumer.run({
      eachMessage: async (payload) => {
        await fanout.handle(payload);
        const eventId = payload.message.headers?.event_id?.toString();
        if (eventId !== undefined) handled.add(eventId);
      },
    });
    await waitFor(() => consumer.assignment().length > 0, 30_000);
    // A new group starts at the latest offset, fixed only once fetching begins: wait until a
    // warm-up event has gone through, so no test event can land before the consumer's position.
    const warmUp = await enqueueStateChange(randomUUID(), 'PREPARING');
    await relayOutbox();
    const deadline = Date.now() + 30_000;
    while (!handled.has(warmUp.event_id)) {
      if (Date.now() > deadline) throw new Error('Kafka consumer never started');
      await sleep(2_000).then(() => new DomainEventPublisher(producer).publish([warmUp]));
    }
  }, 60_000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    await Promise.all([producer.disconnect(), consumer.disconnect()]);
    await new Promise<void>((resolve) => {
      void io.close(() => {
        resolve();
      });
    });
    await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
    await db.$client.end();
  });

  /** A client joined to the room of `orderId`, recording every update it receives. */
  async function joinRoom(orderId: string): Promise<OrderStateUpdate[]> {
    const received: OrderStateUpdate[] = [];
    const client = connectClient(`${url}/orders`, {
      transports: ['websocket'],
      auth: { order_id: orderId },
      reconnection: false,
    });
    clients.push(client);
    client.on('order:state_update', (payload: unknown) => {
      received.push(orderStateUpdateSchema.parse(payload));
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    // The join runs in the server's connection handler; give it a moment.
    await waitFor(() => io.of('/orders').adapter.rooms.has(orderRoom(orderId)), 5_000);
    return received;
  }

  async function enqueueStateChange(orderId: string, toState: 'CANCELED' | 'PREPARING') {
    return enqueueDomainEvent(db, {
      type: 'order.state_changed',
      aggregateId: orderId,
      payload: {
        order_id: orderId,
        customer_id: randomUUID(),
        vendor_id: randomUUID(),
        from_state: 'PLACED',
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

  it('consumes the Kafka event and broadcasts order:state_update to that order room only', async () => {
    const orderId = randomUUID();
    const otherOrderId = randomUUID();
    const tracking = await joinRoom(orderId);
    const bystander = await joinRoom(otherOrderId);

    const event = await enqueueStateChange(orderId, 'CANCELED');
    await relayOutbox();

    await waitFor(() => tracking.length > 0, 30_000);
    expect(tracking).toEqual([
      {
        order_id: orderId,
        state: 'CANCELED',
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: expect.any(String) as unknown,
        delivered_at: null,
        changed_at: event.event_type === 'order.state_changed' ? event.payload.changed_at : '',
      },
    ]);
    // Give any stray broadcast time to arrive before asserting the other room got nothing.
    await sleep(500);
    expect(bystander).toEqual([]);
  }, 60_000);

  it('broadcasts a redelivered event (same event_id) only once', async () => {
    const orderId = randomUUID();
    const tracking = await joinRoom(orderId);
    const event: DomainEvent = await enqueueStateChange(orderId, 'PREPARING');
    await relayOutbox();
    await waitFor(() => tracking.length === 1, 30_000);

    // At-least-once delivery: the same envelope reaches the topic again.
    await new DomainEventPublisher(producer).publish([event]);
    const marker = await enqueueStateChange(orderId, 'CANCELED');
    await relayOutbox();
    await waitFor(() => tracking.length >= 2, 30_000);
    await sleep(300);

    expect(tracking.map((update) => update.state)).toEqual(['PREPARING', 'CANCELED']);
    expect(tracking[1]?.changed_at).toBe(
      marker.event_type === 'order.state_changed' ? marker.payload.changed_at : '',
    );
  }, 60_000);

  it('retries a message whose broadcast failed, and the room still receives it', async () => {
    const orderId = randomUUID();
    const tracking = await joinRoom(orderId);
    failNextBroadcast = true;

    await enqueueStateChange(orderId, 'CANCELED');
    await relayOutbox();

    await waitFor(() => tracking.length > 0, 45_000);
    expect(failNextBroadcast).toBe(false); // the first attempt did fail
    expect(tracking.map((update) => update.state)).toEqual(['CANCELED']);
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

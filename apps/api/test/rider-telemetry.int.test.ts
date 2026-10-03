import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { deliveries } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  orderRiderLocationSchema,
  orderSubscribeAckSchema,
  riderLocationAckSchema,
  SOCKET_IO_REDIS_KEY,
  type OrderRiderLocation,
  type RiderLocationAck,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';

import { signAccessToken } from '../src/auth/access-token';
import { riderLocationKeys, RiderLocationStore } from '../src/deliveries/rider-location-store';
import { attachRealtime, type RealtimeServer } from '../src/realtime/orders-namespace';
import {
  backdatePlacement,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  testRedisUrl,
  vendorUserIdOf,
} from './support/fixtures';
import { ACCESS_SECRET, bearer, bodyOf, buildTestApp, type TestApp } from './support/http';

const THAMEL = { latitude: 27.7154, longitude: 85.3123 };
const PATAN = { latitude: 27.6727, longitude: 85.3249 };

/**
 * Phase 21: rider GPS telemetry on real Redis, PostgreSQL and Socket.io. Riders report on
 * `/orders` (`rider:location`), positions are stored with GEOADD under `riders:active`, and the
 * server periodically pushes the accepting rider's position to the customers subscribed to the
 * order (`order:rider_location`).
 *
 * The Redis database is shared by every suite, so each test uses its own rider ids and looks
 * only at those members.
 */
describe('rider telemetry', () => {
  let t: TestApp;
  let redis: Redis;

  beforeAll(() => {
    t = buildTestApp();
    redis = new Redis(testRedisUrl());
  });

  afterAll(async () => {
    await redis.quit();
    await t.container.close();
  });

  const db = () => t.container.db;

  /** The raw GEOPOS of one member, as [lng, lat] numbers. */
  async function geopos(riderId: string): Promise<[number, number] | null> {
    const [position] = await redis.geopos(riderLocationKeys.active, riderId);
    return position === null || position === undefined
      ? null
      : [Number(position[0]), Number(position[1])];
  }

  describe('RiderLocationStore (GEOADD riders:active)', () => {
    const store = () => t.container.riderLocations;

    it('stores a position as a member of the geo set, longitude first, with its report time', async () => {
      const riderId = randomUUID();
      const before = Date.now();

      const recordedAt = await store().record(riderId, THAMEL);

      expect(await redis.type(riderLocationKeys.active)).toBe('zset');
      const position = await geopos(riderId);
      // Redis keeps a 52-bit geohash: the round trip is exact to well under a metre.
      expect(position?.[0]).toBeCloseTo(THAMEL.longitude, 5);
      expect(position?.[1]).toBeCloseTo(THAMEL.latitude, 5);
      expect(Number(await redis.hget(riderLocationKeys.seen, riderId))).toBe(recordedAt.getTime());
      expect(recordedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(recordedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('is a real geo index: distances and radius searches work on it', async () => {
      const inThamel = randomUUID();
      const inPatan = randomUUID();
      await store().record(inThamel, THAMEL);
      await store().record(inPatan, PATAN);

      const metres = Number(await redis.geodist(riderLocationKeys.active, inThamel, inPatan, 'M'));
      const nearThamel = await redis.geosearch(
        riderLocationKeys.active,
        'FROMLONLAT',
        THAMEL.longitude,
        THAMEL.latitude,
        'BYRADIUS',
        1,
        'km',
      );

      // Thamel to Patan Durbar Square is about 4.9 km as the crow flies.
      expect(metres).toBeGreaterThan(4_700);
      expect(metres).toBeLessThan(5_100);
      expect(nearThamel).toContain(inThamel);
      expect(nearThamel).not.toContain(inPatan);
    });

    it('keeps one position per rider: a new report replaces the old one', async () => {
      const riderId = randomUUID();
      await store().record(riderId, THAMEL);

      await store().record(riderId, PATAN);

      const position = await geopos(riderId);
      expect(position?.[1]).toBeCloseTo(PATAN.latitude, 5);
      expect(await redis.zscore(riderLocationKeys.active, riderId)).not.toBeNull();
      const latest = await store().latest([riderId]);
      expect(latest.size).toBe(1);
      expect(latest.get(riderId)?.latitude).toBeCloseTo(PATAN.latitude, 5);
      expect(latest.get(riderId)?.longitude).toBeCloseTo(PATAN.longitude, 5);
    });

    it('reads several riders at once and leaves out the ones never seen', async () => {
      const seen = randomUUID();
      const alsoSeen = randomUUID();
      const never = randomUUID();
      const recordedAt = await store().record(seen, THAMEL);
      await store().record(alsoSeen, PATAN);

      const latest = await store().latest([seen, never, alsoSeen, seen]);

      expect([...latest.keys()].sort()).toEqual([seen, alsoSeen].sort());
      expect(latest.get(seen)?.recordedAt).toEqual(recordedAt);
      expect(await store().latest([])).toEqual(new Map());
    });

    it('treats a position older than the bound as absent, without deleting it', async () => {
      const riderId = randomUUID();
      let now = new Date('2026-10-03T10:00:00.000Z');
      const aging = new RiderLocationStore(t.container.redisPool, {
        maxAgeMs: 120_000,
        now: () => now,
      });
      await aging.record(riderId, THAMEL);

      now = new Date('2026-10-03T10:02:00.000Z'); // exactly at the bound: still fresh
      expect((await aging.latest([riderId])).has(riderId)).toBe(true);
      now = new Date('2026-10-03T10:02:00.001Z');
      expect((await aging.latest([riderId])).has(riderId)).toBe(false);

      expect(await geopos(riderId)).not.toBeNull();
    });

    it('forgets a rider from both keys', async () => {
      const riderId = randomUUID();
      await store().record(riderId, THAMEL);

      await store().remove(riderId);

      expect(await geopos(riderId)).toBeNull();
      expect(await redis.hget(riderLocationKeys.seen, riderId)).toBeNull();
      expect((await store().latest([riderId])).size).toBe(0);
    });

    it('never has a position without its time when 10 reports race', async () => {
      const riderId = randomUUID();

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store().record(riderId, { latitude: 27.7 + i / 1000, longitude: 85.3 }),
        ),
      );

      expect((await store().latest([riderId])).size).toBe(1);
      expect(await redis.zscore(riderLocationKeys.active, riderId)).not.toBeNull();
    });
  });

  describe('Socket.io /orders: rider:location in, order:rider_location out', () => {
    const key = `test:${randomUUID()}:${SOCKET_IO_REDIS_KEY}`;
    const PUSH_MS = 100;
    const MIN_REPORT_MS = 300;
    let realtime: RealtimeServer;
    let pub: Redis;
    let sub: Redis;
    let url: string;
    const clients: ClientSocket[] = [];

    beforeAll(async () => {
      pub = new Redis(testRedisUrl());
      sub = pub.duplicate();
      const httpServer = createServer(t.app);
      realtime = attachRealtime(httpServer, {
        accessTokenSecret: ACCESS_SECRET,
        orders: t.container.orders,
        vendors: t.container.vendorOrders,
        redis: { pub, sub, key },
        riders: {
          locations: t.container.riderLocations,
          deliveries: t.container.deliveries,
          pushIntervalMs: PUSH_MS,
          minReportIntervalMs: MIN_REPORT_MS,
        },
      });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      for (const client of clients) client.disconnect();
      await realtime.close();
      await Promise.all([pub.quit(), sub.quit()]);
    });

    async function connected(userId: string, role: UserRole) {
      const socket = connectClient(`${url}/orders`, {
        transports: ['websocket'],
        auth: { token: signAccessToken({ userId, role }, ACCESS_SECRET) },
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);
      const raw: unknown[] = [];
      const locations: OrderRiderLocation[] = [];
      socket.on('order:rider_location', (payload: unknown) => {
        raw.push(payload);
        locations.push(orderRiderLocationSchema.parse(payload));
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      return { socket, locations, raw };
    }

    async function report(socket: ClientSocket, payload: unknown): Promise<RiderLocationAck> {
      const ack: unknown = await socket.timeout(5_000).emitWithAck('rider:location', payload);
      return riderLocationAckSchema.parse(ack);
    }

    async function subscribe(socket: ClientSocket, orderId: string) {
      const ack: unknown = await socket
        .timeout(5_000)
        .emitWithAck('orders:subscribe', { order_id: orderId });
      expect(orderSubscribeAckSchema.parse(ack)).toEqual({ ok: true, order_id: orderId });
    }

    async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    /** Long enough for several push rounds. */
    const severalRounds = () => new Promise((resolve) => setTimeout(resolve, PUSH_MS * 5));
    const pastRateLimit = () => new Promise((resolve) => setTimeout(resolve, MIN_REPORT_MS + 50));

    /** A fleet order dispatched through the API: an open gig. */
    async function gig() {
      const customerId = await createUser(db());
      const riderId = await createUser(db(), 'DRIVER');
      const vendorId = await createVendor(db(), { fulfillmentMode: 'PLATFORM_FLEET' });
      const vendorUserId = await vendorUserIdOf(db(), vendorId);
      const productId = await createProduct(db(), vendorId, 10, 500);
      const checkout = await request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', bearer(customerId))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'COD',
          items: [{ product_id: productId, quantity: 2 }],
          delivery_address: DELIVERY_ADDRESS,
        });
      const body = bodyOf(checkoutResponseSchema, checkout);
      const orderId = body.order.id;
      const vendorPost = (action: string) =>
        request(t.app)
          .post(`/api/vendors/orders/${orderId}/${action}`)
          .set('authorization', bearer(vendorUserId, 'VENDOR'));
      expect((await vendorPost('accept')).status).toBe(200);
      await backdatePlacement(db(), orderId, 61);
      expect((await vendorPost('dispatch')).status).toBe(200);
      const [delivery] = await db()
        .select()
        .from(deliveries)
        .where(eq(deliveries.order_id, orderId));
      if (delivery === undefined) throw new Error('dispatch opened no delivery');
      const riderPost = (action: string, rider = riderId) =>
        request(t.app)
          .post(`/api/deliveries/${delivery.id}/${action}`)
          .set('authorization', bearer(rider, 'DRIVER'));
      return { customerId, riderId, orderId, otp: body.delivery_otp ?? '', riderPost };
    }

    describe('rider:location', () => {
      it('stores the position under the token’s rider and acks with the time', async () => {
        const riderId = await createUser(db(), 'DRIVER');
        const rider = await connected(riderId, 'DRIVER');

        const ack = await report(rider.socket, THAMEL);

        if (!ack.ok) throw new Error(`refused: ${ack.error.code}`);
        const position = await geopos(riderId);
        expect(position?.[0]).toBeCloseTo(THAMEL.longitude, 5);
        expect(position?.[1]).toBeCloseTo(THAMEL.latitude, 5);
        expect(Number(await redis.hget(riderLocationKeys.seen, riderId))).toBe(
          new Date(ack.recorded_at).getTime(),
        );
      });

      it('stores a report sent without an ack callback', async () => {
        const riderId = await createUser(db(), 'DRIVER');
        const rider = await connected(riderId, 'DRIVER');

        rider.socket.emit('rider:location', PATAN);

        const deadline = Date.now() + 5_000;
        while ((await geopos(riderId)) === null) {
          if (Date.now() > deadline) throw new Error('position was not stored');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect((await geopos(riderId))?.[1]).toBeCloseTo(PATAN.latitude, 5);
      });

      it.each([
        ['outside Nepal (Delhi)', { latitude: 28.6139, longitude: 77.209 }],
        ['swapped axes', { latitude: 85.3123, longitude: 27.7154 }],
        ['strings', { latitude: '27.7154', longitude: '85.3123' }],
        ['a missing axis', { latitude: 27.7154 }],
        ['a rider id in the payload', { ...THAMEL, rider_id: randomUUID() }],
        ['no payload', undefined],
      ])('refuses %s with VALIDATION_FAILED and stores nothing', async (_name, payload) => {
        const riderId = await createUser(db(), 'DRIVER');
        const rider = await connected(riderId, 'DRIVER');

        const ack = await report(rider.socket, payload);

        expect(ack).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
        expect(await geopos(riderId)).toBeNull();
      });

      it.each<UserRole>(['CUSTOMER', 'VENDOR'])(
        'refuses a %s with FORBIDDEN and stores nothing',
        async (role) => {
          const userId = await createUser(db(), role);
          const client = await connected(userId, role);

          const ack = await report(client.socket, THAMEL);

          expect(ack).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
          expect(await geopos(userId)).toBeNull();
        },
      );

      it('rate-limits a connection: a second report too soon is refused and not stored', async () => {
        const riderId = await createUser(db(), 'DRIVER');
        const rider = await connected(riderId, 'DRIVER');
        expect((await report(rider.socket, THAMEL)).ok).toBe(true);

        const tooSoon = await report(rider.socket, PATAN);

        expect(tooSoon).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
        expect((await geopos(riderId))?.[1]).toBeCloseTo(THAMEL.latitude, 5);
        await pastRateLimit();
        expect((await report(rider.socket, PATAN)).ok).toBe(true);
        expect((await geopos(riderId))?.[1]).toBeCloseTo(PATAN.latitude, 5);
      });
    });

    describe('order:rider_location', () => {
      it('pushes the accepting rider’s position to the order’s customer, with no rider identity', async () => {
        const g = await gig();
        expect((await g.riderPost('accept')).status).toBe(200);
        const customer = await connected(g.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);
        const rider = await connected(g.riderId, 'DRIVER');

        const ack = await report(rider.socket, THAMEL);

        if (!ack.ok) throw new Error(`refused: ${ack.error.code}`);
        await until(() => customer.locations.length > 0);
        const [pushed] = customer.locations;
        expect(pushed?.order_id).toBe(g.orderId);
        expect(pushed?.latitude).toBeCloseTo(THAMEL.latitude, 5);
        expect(pushed?.longitude).toBeCloseTo(THAMEL.longitude, 5);
        expect(pushed?.recorded_at).toBe(ack.recorded_at);
        const raw = JSON.stringify(customer.raw);
        expect(raw).not.toContain(g.riderId);
        expect(raw).not.toContain('+977');
      });

      it('sends one push per report: an unchanged position is not repeated, a new one is', async () => {
        const g = await gig();
        await g.riderPost('accept');
        const customer = await connected(g.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);
        const rider = await connected(g.riderId, 'DRIVER');
        await report(rider.socket, THAMEL);
        await until(() => customer.locations.length === 1);

        await severalRounds();
        expect(customer.locations).toHaveLength(1);

        expect((await report(rider.socket, PATAN)).ok).toBe(true);
        await until(() => customer.locations.length === 2);
        expect(customer.locations[1]?.latitude).toBeCloseTo(PATAN.latitude, 5);
      });

      it('pushes nothing while the gig is open, and starts once a rider accepted it', async () => {
        const g = await gig();
        const customer = await connected(g.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);
        const rider = await connected(g.riderId, 'DRIVER');
        await report(rider.socket, THAMEL);

        await severalRounds();
        expect(customer.locations).toHaveLength(0);

        expect((await g.riderPost('accept')).status).toBe(200);
        await until(() => customer.locations.length === 1);
        expect(customer.locations[0]?.order_id).toBe(g.orderId);
      });

      it('shows only the rider who accepted, never another rider’s position', async () => {
        const g = await gig();
        await g.riderPost('accept');
        const customer = await connected(g.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);
        const otherRiderId = await createUser(db(), 'DRIVER');
        const otherRider = await connected(otherRiderId, 'DRIVER');

        expect((await report(otherRider.socket, PATAN)).ok).toBe(true);

        await severalRounds();
        expect(customer.locations).toHaveLength(0);
      });

      it('keeps orders apart: another customer’s subscription gets nothing', async () => {
        const g = await gig();
        const other = await gig();
        await g.riderPost('accept');
        const customer = await connected(g.customerId, 'CUSTOMER');
        const otherCustomer = await connected(other.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);
        await subscribe(otherCustomer.socket, other.orderId);
        const rider = await connected(g.riderId, 'DRIVER');

        await report(rider.socket, THAMEL);

        await until(() => customer.locations.length === 1);
        await severalRounds();
        expect(otherCustomer.locations).toHaveLength(0);
      });

      it('stops once the order is delivered with the code', async () => {
        const g = await gig();
        await g.riderPost('accept');
        await g.riderPost('pickup');
        const customer = await connected(g.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);
        const rider = await connected(g.riderId, 'DRIVER');
        await report(rider.socket, THAMEL);
        await until(() => customer.locations.length === 1);

        expect((await g.riderPost('complete').send({ delivery_otp: g.otp })).status).toBe(200);
        await pastRateLimit();
        expect((await report(rider.socket, PATAN)).ok).toBe(true);

        await severalRounds();
        expect(customer.locations).toHaveLength(1);
      });

      it('reaches a customer who subscribes after the rider last reported', async () => {
        const g = await gig();
        await g.riderPost('accept');
        const rider = await connected(g.riderId, 'DRIVER');
        await report(rider.socket, THAMEL);
        await severalRounds();

        const customer = await connected(g.customerId, 'CUSTOMER');
        await subscribe(customer.socket, g.orderId);

        await until(() => customer.locations.length === 1);
        expect(customer.locations[0]?.latitude).toBeCloseTo(THAMEL.latitude, 5);
      });
    });
  });
});

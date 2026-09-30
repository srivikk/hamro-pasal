import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { outboxRowToDomainEvent } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  esewaInitiateResponseSchema,
  orderStateChangedPayloadSchema,
  orderStateUpdateFromEvent,
  orderStateUpdateSchema,
  orderSubscribeAckSchema,
  paymentStatusResponseSchema,
  SOCKET_IO_REDIS_KEY,
  type OrderStateChangedEvent,
  type OrderStateUpdate,
  type OrderSubscribeAck,
} from '@hamro-pasal/shared-types';
import { Emitter } from '@socket.io/redis-emitter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';

import { signAccessToken } from '../src/auth/access-token';
import { signRefreshToken } from '../src/auth/refresh-token';
import { attachRealtime, type RealtimeServer } from '../src/realtime/orders-namespace';
import {
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  outboxFor,
  testRedisUrl,
} from './support/fixtures';
import {
  ACCESS_SECRET,
  bearer,
  bodyOf,
  buildTestApp,
  esewaCallback,
  errorOf,
  REFRESH_SECRET,
  type TestApp,
} from './support/http';

/**
 * Phase 8: every order state mutation writes `order.state_changed` to the outbox, and the Socket.io
 * `/orders` namespace (real Express + PostgreSQL + Redis adapter) authenticates, authorises and
 * delivers room broadcasts published through Redis, as the worker does.
 */
describe('real-time order tracking', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  async function setup(stock = 10) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db(), { baseDeliveryFee: 50 });
    const productId = await createProduct(db(), vendorId, stock, 500);
    return { customerId, vendorId, productId };
  }

  async function checkout(
    customerId: string,
    vendorId: string,
    productId: string,
    method: 'COD' | 'ESEWA',
  ) {
    const res = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({
        idempotency_key: randomUUID(),
        vendor_id: vendorId,
        payment_method: method,
        items: [{ product_id: productId, quantity: 2 }],
        delivery_address: DELIVERY_ADDRESS,
      });
    expect(res.status).toBe(201);
    return bodyOf(checkoutResponseSchema, res).order;
  }

  async function payEsewa(app: TestApp, customerId: string, orderId: string) {
    const initiate = await request(app.app)
      .post('/api/payments/esewa/initiate')
      .set('authorization', bearer(customerId))
      .send({ order_id: orderId });
    const uuid = bodyOf(esewaInitiateResponseSchema, initiate).fields.transaction_uuid ?? '';
    return request(app.app)
      .post('/api/payments/esewa/webhook')
      .send({ data: esewaCallback({ transaction_uuid: uuid, total_amount: '1050.0' }) });
  }

  async function cancel(customerId: string, orderId: string) {
    const res = await request(t.app)
      .post(`/api/orders/${orderId}/cancel`)
      .set('authorization', bearer(customerId));
    expect(res.status).toBe(200);
  }

  /** The order's `order.state_changed` events as [from, to] pairs, in commit order. */
  async function transitions(orderId: string) {
    const rows = (await outboxFor(db(), orderId))
      .filter((row) => row.event_type === 'order.state_changed')
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    return rows.map((row) => {
      expect(row.topic).toBe('order.lifecycle');
      const payload = orderStateChangedPayloadSchema.parse(row.payload);
      return [payload.from_state, payload.to_state];
    });
  }

  async function stateChangedEvents(orderId: string): Promise<OrderStateChangedEvent[]> {
    return (await outboxFor(db(), orderId))
      .map((row) => outboxRowToDomainEvent(row))
      .filter(
        (event): event is OrderStateChangedEvent => event.event_type === 'order.state_changed',
      );
  }

  describe('outbox: every state mutation writes order.state_changed', () => {
    it('COD checkout: creation (PENDING_PAYMENT) and placement (PLACED)', async () => {
      const { customerId, vendorId, productId } = await setup();

      const order = await checkout(customerId, vendorId, productId, 'COD');

      expect(await transitions(order.id)).toEqual([
        [null, 'PENDING_PAYMENT'],
        ['PENDING_PAYMENT', 'PLACED'],
      ]);
      const placed = (await stateChangedEvents(order.id)).find(
        (event) => event.payload.to_state === 'PLACED',
      );
      expect(placed?.payload).toMatchObject({
        order_id: order.id,
        customer_id: customerId,
        vendor_id: vendorId,
        payment_status: 'PENDING',
        refund_required: false,
        delivered_at: null,
      });
      expect(placed?.payload.placed_at).not.toBeNull();
    });

    it('COD cancellation (no refund event, but the state change is announced)', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');

      await cancel(customerId, order.id);

      expect((await transitions(order.id)).at(-1)).toEqual(['PLACED', 'CANCELED']);
      const types = (await outboxFor(db(), order.id)).map((row) => row.event_type);
      expect(types).not.toContain('order.canceled_refund_due');
      const [canceled] = (await stateChangedEvents(order.id)).filter(
        (event) => event.payload.to_state === 'CANCELED',
      );
      expect(canceled?.payload).toMatchObject({
        payment_status: 'PENDING',
        refund_required: false,
      });
    });

    it('a repeated cancel announces nothing new', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');

      await cancel(customerId, order.id);
      await cancel(customerId, order.id);

      expect(await transitions(order.id)).toEqual([
        [null, 'PENDING_PAYMENT'],
        ['PENDING_PAYMENT', 'PLACED'],
        ['PLACED', 'CANCELED'],
      ]);
    });

    it('prepaid payment and cancellation (refund_required travels with the update)', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'ESEWA');
      const paid = await payEsewa(t, customerId, order.id);
      expect(bodyOf(paymentStatusResponseSchema, paid).payment?.order_state).toBe('PLACED');

      await cancel(customerId, order.id);

      expect(await transitions(order.id)).toEqual([
        [null, 'PENDING_PAYMENT'],
        ['PENDING_PAYMENT', 'PLACED'],
        ['PLACED', 'CANCELED'],
      ]);
      const [canceled] = (await stateChangedEvents(order.id)).filter(
        (event) => event.payload.to_state === 'CANCELED',
      );
      expect(canceled?.payload).toMatchObject({ payment_status: 'PAID', refund_required: true });
    });

    it('payment after the lock expired (FAILED)', async () => {
      const short = buildTestApp({ lockTtlMs: 1_500 });
      try {
        const { customerId, vendorId, productId } = await setup();
        const res = await request(short.app)
          .post('/api/cart/checkout')
          .set('authorization', bearer(customerId))
          .send({
            idempotency_key: randomUUID(),
            vendor_id: vendorId,
            payment_method: 'ESEWA',
            items: [{ product_id: productId, quantity: 2 }],
            delivery_address: DELIVERY_ADDRESS,
          });
        const orderId = bodyOf(checkoutResponseSchema, res).order.id;
        const initiate = await request(short.app)
          .post('/api/payments/esewa/initiate')
          .set('authorization', bearer(customerId))
          .send({ order_id: orderId });
        const uuid = bodyOf(esewaInitiateResponseSchema, initiate).fields.transaction_uuid ?? '';
        await new Promise((resolve) => setTimeout(resolve, 1_800));

        const late = await request(short.app)
          .post('/api/payments/esewa/webhook')
          .send({ data: esewaCallback({ transaction_uuid: uuid, total_amount: '1050.0' }) });

        expect(errorOf(late).code).toBe('PAID_AFTER_SESSION_EXPIRED');
        expect(await transitions(orderId)).toEqual([
          [null, 'PENDING_PAYMENT'],
          ['PENDING_PAYMENT', 'FAILED'],
        ]);
        const [failed] = (await stateChangedEvents(orderId)).filter(
          (event) => event.payload.to_state === 'FAILED',
        );
        expect(failed?.payload).toMatchObject({ payment_status: 'PAID', placed_at: null });
      } finally {
        await short.container.close();
      }
    });
  });

  describe('Socket.io /orders namespace', () => {
    // Redis pub/sub is not scoped by logical DB: a unique key isolates this run's broadcasts.
    const key = `test:${randomUUID()}:${SOCKET_IO_REDIS_KEY}`;
    let realtime: RealtimeServer;
    let pub: Redis;
    let sub: Redis;
    let emitterRedis: Redis;
    let url: string;
    const clients: ClientSocket[] = [];

    beforeAll(async () => {
      pub = new Redis(testRedisUrl());
      sub = pub.duplicate();
      emitterRedis = new Redis(testRedisUrl());
      const httpServer = createServer(t.app);
      realtime = attachRealtime(httpServer, {
        accessTokenSecret: ACCESS_SECRET,
        orders: t.container.orders,
        redis: { pub, sub, key },
      });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      for (const client of clients) client.disconnect();
      await realtime.close();
      await Promise.all([pub.quit(), sub.quit(), emitterRedis.quit()]);
    });

    function token(userId: string, role: 'CUSTOMER' | 'VENDOR' = 'CUSTOMER'): string {
      return signAccessToken({ userId, role }, ACCESS_SECRET);
    }

    function client(auth: Record<string, unknown>): ClientSocket {
      const socket = connectClient(`${url}/orders`, {
        transports: ['websocket'],
        auth,
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);
      return socket;
    }

    async function connected(auth: Record<string, unknown>) {
      const socket = client(auth);
      const updates: OrderStateUpdate[] = [];
      socket.on('order:state_update', (payload: unknown) => {
        updates.push(orderStateUpdateSchema.parse(payload));
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      return { socket, updates };
    }

    /** Resolves the handshake refusal as `{ message, code }`. */
    function refusal(auth: Record<string, unknown>) {
      const socket = client(auth);
      return new Promise<{ message: string; code: unknown }>((resolve, reject) => {
        socket.once('connect', () => {
          reject(new Error('connection was accepted'));
        });
        socket.once('connect_error', (error: Error & { data?: { code?: unknown } }) => {
          resolve({ message: error.message, code: error.data?.code });
        });
      });
    }

    async function subscribe(socket: ClientSocket, payload: unknown): Promise<OrderSubscribeAck> {
      const ack: unknown = await socket.timeout(5_000).emitWithAck('orders:subscribe', payload);
      return orderSubscribeAckSchema.parse(ack);
    }

    /** Publishes into a room exactly as the worker does (another process, via Redis). */
    function publishFromWorker(update: OrderStateUpdate): void {
      new Emitter(emitterRedis, { key })
        .of('/orders')
        .to(`order:${update.order_id}`)
        .emit('order:state_update', update);
    }

    function update(orderId: string, state: OrderStateUpdate['state']): OrderStateUpdate {
      return {
        order_id: orderId,
        state,
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: '2026-09-30T10:00:00.000Z',
        delivered_at: null,
        changed_at: new Date().toISOString(),
      };
    }

    async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it('advertises the 25 s heartbeat and serves WebSocket only', () => {
      expect(realtime.io.engine.opts.pingInterval).toBe(25_000);
      expect(realtime.io.engine.opts.transports).toEqual(['websocket']);
    });

    it.each([
      ['no token', {}],
      ['an empty token', { token: '' }],
      ['a malformed token', { token: 'not-a-jwt' }],
      [
        'a token signed with another secret',
        { token: signAccessToken({ userId: randomUUID(), role: 'CUSTOMER' }, 'x'.repeat(40)) },
      ],
      ['a refresh token', { token: signRefreshToken(randomUUID(), REFRESH_SECRET) }],
    ])('refuses a handshake with %s (UNAUTHENTICATED)', async (_label, auth) => {
      await expect(refusal(auth)).resolves.toEqual({
        message: 'UNAUTHENTICATED',
        code: 'UNAUTHENTICATED',
      });
    });

    it('refuses an expired access token', async () => {
      const expired = jwt.sign({ role: 'CUSTOMER' }, ACCESS_SECRET, {
        algorithm: 'HS256',
        subject: randomUUID(),
        issuer: 'hamro-pasal-api',
        audience: 'hamro-pasal-app',
        expiresIn: -10,
      });

      await expect(refusal({ token: expired })).resolves.toMatchObject({
        message: 'UNAUTHENTICATED',
      });
    });

    it('refuses roles other than CUSTOMER', async () => {
      await expect(refusal({ token: token(randomUUID(), 'VENDOR') })).resolves.toEqual({
        message: 'FORBIDDEN',
        code: 'FORBIDDEN',
      });
    });

    it('joins the owner to order:{id}, where worker broadcasts reach them', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');
      const { socket, updates } = await connected({ token: token(customerId) });

      await expect(subscribe(socket, { order_id: order.id })).resolves.toEqual({
        ok: true,
        order_id: order.id,
      });
      publishFromWorker(update(order.id, 'PREPARING'));

      await until(() => updates.length === 1);
      expect(updates[0]).toMatchObject({ order_id: order.id, state: 'PREPARING' });
    });

    it("answers ORDER_NOT_FOUND for another customer's order and never delivers its updates", async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');
      const owner = await connected({ token: token(customerId) });
      const stranger = await connected({ token: token(await createUser(db())) });
      await subscribe(owner.socket, { order_id: order.id });

      await expect(subscribe(stranger.socket, { order_id: order.id })).resolves.toEqual({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' },
      });
      // Same answer for an id that does not exist at all: ids cannot be probed.
      await expect(subscribe(stranger.socket, { order_id: randomUUID() })).resolves.toMatchObject({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND' },
      });

      publishFromWorker(update(order.id, 'OUT_FOR_DELIVERY'));
      await until(() => owner.updates.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(stranger.updates).toEqual([]);
    });

    it('rejects a malformed subscription', async () => {
      const { socket } = await connected({ token: token(await createUser(db())) });

      await expect(subscribe(socket, { order_id: 'not-a-uuid' })).resolves.toMatchObject({
        ok: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      await expect(subscribe(socket, 'garbage')).resolves.toMatchObject({ ok: false });
    });

    it('delivers only the subscribed order, and nothing after unsubscribe', async () => {
      const { customerId, vendorId, productId } = await setup(20);
      const first = await checkout(customerId, vendorId, productId, 'COD');
      const second = await checkout(customerId, vendorId, productId, 'COD');
      const { socket, updates } = await connected({ token: token(customerId) });
      await subscribe(socket, { order_id: first.id });

      publishFromWorker(update(second.id, 'PREPARING'));
      publishFromWorker(update(first.id, 'PREPARING'));
      await until(() => updates.length === 1);
      expect(updates[0]?.order_id).toBe(first.id);

      socket.emit('orders:unsubscribe', { order_id: first.id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      publishFromWorker(update(first.id, 'OUT_FOR_DELIVERY'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(updates).toHaveLength(1);
    });

    it('a real cancellation reaches the tracking customer as order:state_update CANCELED', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');
      const { socket, updates } = await connected({ token: token(customerId) });
      await subscribe(socket, { order_id: order.id });

      await cancel(customerId, order.id);
      // What the worker does with the committed outbox row (the Kafka hop is tested in apps/worker).
      const event = (await stateChangedEvents(order.id)).find(
        (candidate) => candidate.payload.to_state === 'CANCELED',
      );
      if (event === undefined) throw new Error('no CANCELED event in the outbox');
      publishFromWorker(orderStateUpdateFromEvent(event));

      await until(() => updates.length === 1);
      expect(updates[0]).toEqual({
        order_id: order.id,
        state: 'CANCELED',
        payment_status: 'PENDING',
        refund_required: false,
        placed_at: event.payload.placed_at,
        delivered_at: null,
        changed_at: event.payload.changed_at,
      });
    });

    it('rooms do not survive a reconnect: the client must subscribe again', async () => {
      const { customerId, vendorId, productId } = await setup();
      const order = await checkout(customerId, vendorId, productId, 'COD');
      const first = await connected({ token: token(customerId) });
      await subscribe(first.socket, { order_id: order.id });
      first.socket.disconnect();

      const again = await connected({ token: token(customerId) });
      publishFromWorker(update(order.id, 'PREPARING'));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(again.updates).toEqual([]);

      await subscribe(again.socket, { order_id: order.id });
      publishFromWorker(update(order.id, 'OUT_FOR_DELIVERY'));
      await until(() => again.updates.length === 1);
      expect(again.updates[0]?.state).toBe('OUT_FOR_DELIVERY');
    });
  });
});

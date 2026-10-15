import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rm } from 'node:fs/promises';

import { chatMessages, disputes, orders, users, vendors } from '@hamro-pasal/db';
import {
  chatJoinAckSchema,
  chatMessageSchema,
  chatSendAckSchema,
  disputeEvidenceUploadResponseSchema,
  SOCKET_IO_REDIS_KEY,
  type ChatJoinAck,
  type ChatSendAck,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';

import { signAccessToken } from '../src/auth/access-token';
import { attachRealtime, type RealtimeServer } from '../src/realtime/orders-namespace';
import {
  createOrder,
  createUser,
  createVendor,
  markDelivered,
  testRedisUrl,
} from './support/fixtures';
import {
  ACCESS_SECRET,
  bearer,
  bodyOf,
  buildTestApp,
  TEST_UPLOADS_DIR,
  type TestApp,
} from './support/http';
import { photo } from './support/images';

/**
 * Phase 9: the Socket.io /chat namespace on two API instances joined by the Redis adapter, against
 * real PostgreSQL rows that carry last names and phone numbers. The customer and the vendor sit on
 * different instances; every broadcast must arrive without last_name or phone_number.
 */
describe('dispute chat (/chat)', () => {
  let t: TestApp;
  // Redis pub/sub is not scoped by logical DB: a unique key isolates this run's broadcasts.
  const key = `test:${randomUUID()}:${SOCKET_IO_REDIS_KEY}`;
  const instances: { realtime: RealtimeServer; url: string; pub: Redis; sub: Redis }[] = [];
  const clients: ClientSocket[] = [];

  beforeAll(async () => {
    t = buildTestApp();
    for (let i = 0; i < 2; i++) {
      const pub = new Redis(testRedisUrl());
      const sub = pub.duplicate();
      const httpServer = createServer(t.app);
      const realtime = attachRealtime(httpServer, {
        accessTokenSecret: ACCESS_SECRET,
        orders: t.container.orders,
        vendors: t.container.vendorOrders,
        redis: { pub, sub, key },
        chat: { disputes: t.container.disputes, evidence: t.container.evidence },
      });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
      instances.push({ realtime, url, pub, sub });
    }
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
  });

  afterAll(async () => {
    for (const { realtime, pub, sub } of instances) {
      await realtime.close();
      await Promise.all([pub.quit(), sub.quit()]);
    }
    await t.container.close();
    await rm(TEST_UPLOADS_DIR, { recursive: true, force: true });
  });

  const db = () => t.container.db;

  async function named(role: UserRole, first: string | null, last: string): Promise<string> {
    const id = await createUser(db(), role);
    await db().update(users).set({ first_name: first, last_name: last }).where(eq(users.id, id));
    return id;
  }

  async function phoneOf(userId: string): Promise<string> {
    const [row] = await db().select({ phone: users.phone }).from(users).where(eq(users.id, userId));
    return row?.phone ?? '';
  }

  /** A delivered order between a named customer and a named vendor user. */
  async function dispute(hoursSinceDelivery = 1) {
    const customerId = await named('CUSTOMER', 'Aarav', 'Sharma');
    const vendorId = await createVendor(db());
    const [vendor] = await db()
      .select({ userId: vendors.user_id })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    const vendorUserId = vendor?.userId ?? '';
    await db()
      .update(users)
      .set({ first_name: 'Ram', last_name: 'Shrestha' })
      .where(eq(users.id, vendorUserId));
    const order = await createOrder(db(), { vendorId, customerId });
    await markDelivered(db(), order.id);
    await db()
      .update(orders)
      .set({
        delivered_at: sql`now() - make_interval(secs => ${hoursSinceDelivery * 3600}::float8)`,
      })
      .where(eq(orders.id, order.id));
    const pii = [
      'last_name',
      'phone_number',
      '"phone"',
      'Sharma',
      'Shrestha',
      await phoneOf(customerId),
      await phoneOf(vendorUserId),
    ];
    return { customerId, vendorUserId, orderId: order.id, pii };
  }

  /** Step 7.3: the customer escalated the order's conversation to Hamro Pasal. */
  async function escalate(orderId: string, customerId: string): Promise<void> {
    const values = {
      status: 'ESCALATED' as const,
      escalated_at: new Date(),
      escalated_by_user_id: customerId,
      escalation_reason: 'The honey jar arrived broken.',
    };
    await db()
      .insert(disputes)
      .values({ order_id: orderId, opened_by_user_id: customerId, ...values })
      .onConflictDoUpdate({ target: disputes.order_id, set: values });
  }

  async function participant(instance: number, userId: string, role: UserRole) {
    const socket = connectClient(`${instances[instance]?.url ?? ''}/chat`, {
      transports: ['websocket'],
      auth: { token: signAccessToken({ userId, role }, ACCESS_SECRET) },
      reconnection: false,
      forceNew: true,
    });
    clients.push(socket);
    const received: unknown[] = [];
    socket.on('chat:new_message', (payload: unknown) => {
      received.push(payload);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { socket, received };
  }

  async function join(socket: ClientSocket, orderId: string): Promise<ChatJoinAck> {
    return chatJoinAckSchema.parse(
      await socket.timeout(5_000).emitWithAck('chat:join', { order_id: orderId }),
    );
  }

  async function send(socket: ClientSocket, payload: object): Promise<ChatSendAck> {
    return chatSendAckSchema.parse(
      await socket.timeout(5_000).emitWithAck('chat:new_message', payload),
    );
  }

  async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function expectNoPii(value: unknown, pii: readonly string[]): void {
    const json = JSON.stringify(value);
    for (const needle of pii) expect(json).not.toContain(needle);
  }

  it('relays a message across instances with last_name and phone stripped', async () => {
    const { customerId, vendorUserId, orderId, pii } = await dispute();
    const customer = await participant(0, customerId, 'CUSTOMER');
    const vendor = await participant(1, vendorUserId, 'VENDOR');
    expect(await join(customer.socket, orderId)).toEqual({ ok: true, order_id: orderId });
    expect(await join(vendor.socket, orderId)).toEqual({ ok: true, order_id: orderId });

    const ack = await send(customer.socket, {
      client_id: 'c-1',
      order_id: orderId,
      body: 'The honey jar arrived broken.',
    });
    await until(() => vendor.received.length === 1 && customer.received.length === 1);

    expectNoPii(vendor.received, pii);
    expectNoPii(customer.received, pii);
    expectNoPii(ack, pii);
    const message = chatMessageSchema.parse(vendor.received[0]);
    expect(message).toMatchObject({
      client_id: 'c-1',
      order_id: orderId,
      sender: { id: customerId, first_name: 'Aarav', role: 'CUSTOMER' },
      body: 'The honey jar arrived broken.',
    });
    expect(Object.keys(message.sender).sort()).toEqual(['first_name', 'id', 'role']);
    expect(ack).toEqual({ ok: true, message: vendor.received[0] });

    // And the reply goes back the other way, filtered the same.
    await send(vendor.socket, { client_id: 'v-1', order_id: orderId, body: 'Sorry! Refunding.' });
    await until(() => customer.received.length === 2);
    expectNoPii(customer.received, pii);
    expect(chatMessageSchema.parse(customer.received[1]).sender).toEqual({
      id: vendorUserId,
      first_name: 'Ram',
      role: 'VENDOR',
    });
  });

  it('lets a Super Admin join an escalated conversation only, identified by role when unnamed', async () => {
    const { customerId, orderId, pii } = await dispute();
    const adminId = await named('SUPER_ADMIN', null, 'Adhikari');
    const customer = await participant(0, customerId, 'CUSTOMER');
    const early = await participant(1, adminId, 'SUPER_ADMIN');
    // Step 7.3: not escalated, the Super Admin cannot read or join it.
    expect(await join(early.socket, orderId)).toMatchObject({
      ok: false,
      error: { code: 'ORDER_NOT_FOUND' },
    });
    await escalate(orderId, customerId);
    const admin = await participant(1, adminId, 'SUPER_ADMIN');
    await join(customer.socket, orderId);
    expect(await join(admin.socket, orderId)).toEqual({ ok: true, order_id: orderId });

    await send(admin.socket, { client_id: 'a-1', order_id: orderId, body: 'Looking into it.' });
    await until(() => customer.received.length === 1);

    expectNoPii(customer.received, [...pii, 'Adhikari', await phoneOf(adminId)]);
    expect(chatMessageSchema.parse(customer.received[0]).sender).toEqual({
      id: adminId,
      first_name: null,
      role: 'SUPER_ADMIN',
    });
  });

  it('refuses outsiders (another customer, another vendor) as if the order did not exist', async () => {
    const { orderId } = await dispute();
    const otherCustomer = await participant(0, await createUser(db()), 'CUSTOMER');
    const otherVendor = await participant(1, await createUser(db(), 'VENDOR'), 'VENDOR');

    for (const outsider of [otherCustomer, otherVendor]) {
      expect(await join(outsider.socket, orderId)).toMatchObject({
        ok: false,
        error: { code: 'ORDER_NOT_FOUND' },
      });
      expect(
        await send(outsider.socket, { client_id: 'x', order_id: orderId, body: 'hi' }),
      ).toMatchObject({ ok: false, error: { code: 'ORDER_NOT_FOUND' } });
    }
  });

  it('stays open for 7 days after delivery and closes then (step 7.3)', async () => {
    const open = await dispute(167.9);
    const inTime = await participant(0, open.customerId, 'CUSTOMER');
    expect(await join(inTime.socket, open.orderId)).toEqual({ ok: true, order_id: open.orderId });

    const { customerId, orderId } = await dispute(168.1);
    const customer = await participant(0, customerId, 'CUSTOMER');

    expect(await join(customer.socket, orderId)).toMatchObject({
      ok: false,
      error: { code: 'DISPUTE_WINDOW_CLOSED' },
    });
  });

  it('carries evidence uploaded through POST /api/uploads/dispute-evidence', async () => {
    const { customerId, vendorUserId, orderId, pii } = await dispute();
    const jpeg = await photo();
    const uploaded = bodyOf(
      disputeEvidenceUploadResponseSchema,
      await request(t.app)
        .post('/api/uploads/dispute-evidence')
        .set('authorization', bearer(customerId))
        .field('order_id', orderId)
        .attach('file', jpeg, { filename: 'jar.jpg', contentType: 'image/jpeg' }),
    );
    const customer = await participant(0, customerId, 'CUSTOMER');
    const vendor = await participant(1, vendorUserId, 'VENDOR');
    await join(customer.socket, orderId);
    await join(vendor.socket, orderId);

    const ack = await send(customer.socket, {
      client_id: 'c-img',
      order_id: orderId,
      body: '',
      attachments: [uploaded],
    });
    await until(() => vendor.received.length === 1);

    expect(ack.ok).toBe(true);
    expect(chatMessageSchema.parse(vendor.received[0]).attachments).toEqual([uploaded]);
    expectNoPii(vendor.received, pii);
  });

  describe('persistence (Phase 9.5)', () => {
    async function disputesOf(orderId: string) {
      return db().select().from(disputes).where(eq(disputes.order_id, orderId));
    }

    async function transcriptOf(orderId: string) {
      const rows = await db()
        .select({ message: chatMessages })
        .from(chatMessages)
        .innerJoin(disputes, eq(disputes.id, chatMessages.dispute_id))
        .where(eq(disputes.order_id, orderId))
        .orderBy(chatMessages.created_at);
      return rows.map((row) => row.message);
    }

    it('stores the message before broadcasting it, under the stored id and time', async () => {
      const { customerId, vendorUserId, orderId } = await dispute();
      const customer = await participant(0, customerId, 'CUSTOMER');
      const vendor = await participant(1, vendorUserId, 'VENDOR');
      await join(vendor.socket, orderId);

      const ack = await send(customer.socket, {
        client_id: 'c-persist',
        order_id: orderId,
        body: '  The honey jar arrived broken.  ',
      });
      await until(() => vendor.received.length === 1);

      const [row] = await transcriptOf(orderId);
      expect(row).toMatchObject({
        sender_user_id: customerId,
        client_id: 'c-persist',
        body: 'The honey jar arrived broken.',
        attachments: [],
      });
      const broadcast = chatMessageSchema.parse(vendor.received[0]);
      expect(broadcast.id).toBe(row?.id);
      expect(broadcast.sent_at).toBe(row?.created_at.toISOString());
      expect(ack).toEqual({ ok: true, message: vendor.received[0] });
    });

    it("the order's first message opens its conversation; later ones join it", async () => {
      const { customerId, vendorUserId, orderId } = await dispute();
      const customer = await participant(0, customerId, 'CUSTOMER');
      const vendor = await participant(1, vendorUserId, 'VENDOR');
      expect(await disputesOf(orderId)).toEqual([]);

      await send(customer.socket, { client_id: 'c-1', order_id: orderId, body: 'Jar broken.' });
      const opened = await disputesOf(orderId);
      await send(vendor.socket, { client_id: 'v-1', order_id: orderId, body: 'Sorry! Photo?' });
      await send(customer.socket, { client_id: 'c-2', order_id: orderId, body: 'Attached.' });

      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        order_id: orderId,
        opened_by_user_id: customerId,
        // Step 7.3: a conversation is not a complaint; an escalation carries the reason.
        reason: null,
        status: 'OPEN',
        resolved_by_user_id: null,
        resolved_at: null,
      });
      expect(await disputesOf(orderId)).toEqual(opened);
      const transcript = await transcriptOf(orderId);
      expect(transcript.map((m) => [m.sender_user_id, m.body])).toEqual([
        [customerId, 'Jar broken.'],
        [vendorUserId, 'Sorry! Photo?'],
        [customerId, 'Attached.'],
      ]);
      expect(new Set(transcript.map((m) => m.dispute_id))).toEqual(new Set([opened[0]?.id]));
    });

    it('a vendor can open the dispute too', async () => {
      const { vendorUserId, orderId } = await dispute();
      const vendor = await participant(1, vendorUserId, 'VENDOR');

      await send(vendor.socket, { client_id: 'v-1', order_id: orderId, body: 'Customer refused.' });

      expect(await disputesOf(orderId)).toMatchObject([
        { opened_by_user_id: vendorUserId, reason: null, status: 'OPEN' },
      ]);
    });

    it('a photo-only first message opens the conversation too', async () => {
      const { customerId, orderId } = await dispute();
      const jpeg = await photo();
      const uploaded = bodyOf(
        disputeEvidenceUploadResponseSchema,
        await request(t.app)
          .post('/api/uploads/dispute-evidence')
          .set('authorization', bearer(customerId))
          .field('order_id', orderId)
          .attach('file', jpeg, { filename: 'jar.jpg', contentType: 'image/jpeg' }),
      );
      const customer = await participant(0, customerId, 'CUSTOMER');

      await send(customer.socket, {
        client_id: 'c-img',
        order_id: orderId,
        body: '',
        attachments: [uploaded],
      });

      expect((await disputesOf(orderId))[0]).toMatchObject({ status: 'OPEN', reason: null });
      expect((await transcriptOf(orderId))[0]?.attachments).toEqual([uploaded]);
    });

    it('stores a retried send (same client_id) once and acks the same message', async () => {
      const { customerId, orderId } = await dispute();
      const customer = await participant(0, customerId, 'CUSTOMER');
      const payload = { client_id: 'c-retry', order_id: orderId, body: 'Hello?' };

      const first = await send(customer.socket, payload);
      const retried = await send(customer.socket, payload);

      expect(await transcriptOf(orderId)).toHaveLength(1);
      expect(first.ok && retried.ok && retried.message.id === first.message.id).toBe(true);
    });

    it('opens exactly one dispute when both parties send their first message at once', async () => {
      for (let round = 0; round < 5; round++) {
        const { customerId, vendorUserId, orderId } = await dispute();
        const customer = await participant(0, customerId, 'CUSTOMER');
        const vendor = await participant(1, vendorUserId, 'VENDOR');

        const acks = await Promise.all([
          send(customer.socket, { client_id: 'c', order_id: orderId, body: 'Broken.' }),
          send(vendor.socket, { client_id: 'v', order_id: orderId, body: 'Refused.' }),
        ]);

        expect(acks.every((ack) => ack.ok)).toBe(true);
        expect(await disputesOf(orderId)).toHaveLength(1);
        expect(await transcriptOf(orderId)).toHaveLength(2);
      }
    });

    it('keeps an escalated conversation reachable after the 7-day window, until it is resolved', async () => {
      const { customerId, vendorUserId, orderId } = await dispute(160);
      const early = await participant(0, customerId, 'CUSTOMER');
      await send(early.socket, { client_id: 'c-1', order_id: orderId, body: 'Opened in time.' });
      await escalate(orderId, customerId);
      await db()
        .update(orders)
        .set({ delivered_at: sql`now() - make_interval(hours => 169)` })
        .where(eq(orders.id, orderId));

      const customer = await participant(0, customerId, 'CUSTOMER');
      const vendor = await participant(1, vendorUserId, 'VENDOR');

      expect(await join(customer.socket, orderId)).toEqual({ ok: true, order_id: orderId });
      expect(await join(vendor.socket, orderId)).toEqual({ ok: true, order_id: orderId });
      expect(
        await send(vendor.socket, { client_id: 'v-late', order_id: orderId, body: 'Refunding.' }),
      ).toMatchObject({ ok: true });

      const [open] = await disputesOf(orderId);
      await db()
        .update(disputes)
        .set({
          status: 'REFUNDED_TO_CUSTOMER',
          resolved_at: new Date(),
          resolved_by_user_id: customerId,
          resolution_note: 'Refunded in full.',
          refund_npr: 100,
        })
        .where(eq(disputes.id, open?.id ?? ''));
      const afterResolution = await participant(0, customerId, 'CUSTOMER');
      expect(await join(afterResolution.socket, orderId)).toMatchObject({
        ok: false,
        error: { code: 'DISPUTE_WINDOW_CLOSED' },
      });
    });

    it('stores nothing and opens nothing for refused messages', async () => {
      const { orderId } = await dispute(168.1);
      const outsider = await participant(0, await createUser(db()), 'CUSTOMER');
      const late = await dispute(168.1);
      const lateCustomer = await participant(0, late.customerId, 'CUSTOMER');

      await send(outsider.socket, { client_id: 'x', order_id: orderId, body: 'hi' });
      await send(lateCustomer.socket, { client_id: 'y', order_id: late.orderId, body: 'hi' });

      expect(await disputesOf(orderId)).toEqual([]);
      expect(await disputesOf(late.orderId)).toEqual([]);
      expect(await transcriptOf(late.orderId)).toEqual([]);
    });
  });
});

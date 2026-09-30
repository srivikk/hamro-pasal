import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { disputes, orders, users, vendors } from '@hamro-pasal/db';
import {
  chatHistoryResponseSchema,
  chatSendAckSchema,
  type ChatMessage,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
import { io as connectClient } from 'socket.io-client';
import request from 'supertest';

import { signAccessToken } from '../src/auth/access-token';
import { attachRealtime, type RealtimeServer } from '../src/realtime/orders-namespace';
import { createOrder, createUser, createVendor, markDelivered } from './support/fixtures';
import { ACCESS_SECRET, bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 9.6: GET /api/orders/:id/chat returns the persisted dispute transcript, oldest first,
 * through the same privacy filter as the /chat broadcast.
 */
describe('GET /api/orders/:id/chat', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
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

  /** A delivered order between Aarav Sharma and Ram Shrestha (the vendor's user). */
  async function deliveredOrder() {
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

  function say(orderId: string, senderUserId: string, clientId: string, body: string) {
    return t.container.disputes.recordMessage({
      orderId,
      senderUserId,
      clientId,
      body,
      attachments: [],
    });
  }

  function history(orderId: string, authorization: string | null) {
    const req = request(t.app).get(`/api/orders/${orderId}/chat`);
    return authorization === null ? req : req.set('authorization', authorization);
  }

  function expectNoPii(value: unknown, pii: readonly string[]): void {
    const json = JSON.stringify(value);
    for (const needle of pii) expect(json).not.toContain(needle);
  }

  it('returns the transcript oldest first, with senders reduced to id, first name and role', async () => {
    const { customerId, vendorUserId, orderId, pii } = await deliveredOrder();
    await say(orderId, customerId, 'c-1', 'The honey jar arrived broken.');
    await say(orderId, vendorUserId, 'v-1', 'Sorry! Can you share a photo?');
    await say(orderId, customerId, 'c-2', 'Attached above.');

    const res = await history(orderId, bearer(customerId));

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expectNoPii(res.body, pii);
    const { messages } = bodyOf(chatHistoryResponseSchema, res);
    expect(messages.map((m) => [m.sender, m.body])).toEqual([
      [{ id: customerId, first_name: 'Aarav', role: 'CUSTOMER' }, 'The honey jar arrived broken.'],
      [{ id: vendorUserId, first_name: 'Ram', role: 'VENDOR' }, 'Sorry! Can you share a photo?'],
      [{ id: customerId, first_name: 'Aarav', role: 'CUSTOMER' }, 'Attached above.'],
    ]);
    for (const message of messages) {
      expect(Object.keys(message.sender).sort()).toEqual(['first_name', 'id', 'role']);
      expect(message.order_id).toBe(orderId);
    }
    const times = messages.map((m) => Date.parse(m.sent_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('lets the vendor and a Super Admin read it too', async () => {
    const { customerId, vendorUserId, orderId, pii } = await deliveredOrder();
    const adminId = await named('SUPER_ADMIN', null, 'Adhikari');
    await say(orderId, customerId, 'c-1', 'Broken jar.');
    await say(orderId, adminId, 'a-1', 'Looking into it.');

    const asVendor = await history(orderId, bearer(vendorUserId, 'VENDOR'));
    const asAdmin = await history(orderId, bearer(adminId, 'SUPER_ADMIN'));

    for (const res of [asVendor, asAdmin]) {
      expect(res.status).toBe(200);
      expectNoPii(res.body, [...pii, 'Adhikari', await phoneOf(adminId)]);
      expect(bodyOf(chatHistoryResponseSchema, res).messages.map((m) => m.sender)).toEqual([
        { id: customerId, first_name: 'Aarav', role: 'CUSTOMER' },
        { id: adminId, first_name: null, role: 'SUPER_ADMIN' },
      ]);
    }
  });

  it('returns an empty transcript while the order has no dispute', async () => {
    const { customerId, orderId } = await deliveredOrder();

    const res = await history(orderId, bearer(customerId));

    expect(res.status).toBe(200);
    expect(bodyOf(chatHistoryResponseSchema, res)).toEqual({ messages: [] });
  });

  it('stays readable to the parties after the window closed and the dispute was resolved', async () => {
    const { customerId, orderId } = await deliveredOrder();
    await say(orderId, customerId, 'c-1', 'Broken jar.');
    await db()
      .update(orders)
      .set({ delivered_at: sql`now() - make_interval(hours => 72)` })
      .where(eq(orders.id, orderId));
    await db()
      .update(disputes)
      .set({
        status: 'REFUNDED_TO_CUSTOMER',
        resolved_at: new Date(),
        resolved_by_user_id: customerId,
      })
      .where(eq(disputes.order_id, orderId));

    const res = await history(orderId, bearer(customerId));

    expect(res.status).toBe(200);
    expect(bodyOf(chatHistoryResponseSchema, res).messages).toHaveLength(1);
  });

  it('answers 404 to anyone who is not a party, without revealing the order exists', async () => {
    const { customerId, orderId } = await deliveredOrder();
    await say(orderId, customerId, 'c-1', 'Broken jar.');
    const otherCustomer = await createUser(db());
    const otherVendorUser = await createUser(db(), 'VENDOR');

    const asOtherCustomer = await history(orderId, bearer(otherCustomer));
    const asOtherVendor = await history(orderId, bearer(otherVendorUser, 'VENDOR'));
    const unknownOrder = await history(randomUUID(), bearer(customerId));

    for (const res of [asOtherCustomer, asOtherVendor, unknownOrder]) {
      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
    }
  });

  it('needs a customer, vendor or admin access token', async () => {
    const { orderId } = await deliveredOrder();

    const anonymous = await history(orderId, null);
    const asDriver = await history(orderId, bearer(await createUser(db(), 'DRIVER'), 'DRIVER'));
    const badId = await history('not-a-uuid', bearer(await createUser(db())));

    expect(anonymous.status).toBe(401);
    expect(asDriver.status).toBe(403);
    expect(badId.status).toBe(400);
  });

  it('does not change who may use the other order routes', async () => {
    const { vendorUserId, orderId } = await deliveredOrder();

    const vendorReadsOrder = await request(t.app)
      .get(`/api/orders/${orderId}`)
      .set('authorization', bearer(vendorUserId, 'VENDOR'));

    expect(vendorReadsOrder.status).toBe(403);
  });

  it('returns each message exactly as /chat broadcast it', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const httpServer = createServer(t.app);
    const realtime: RealtimeServer = attachRealtime(httpServer, {
      accessTokenSecret: ACCESS_SECRET,
      orders: t.container.orders,
      vendors: t.container.vendorOrders,
      chat: { disputes: t.container.disputes, evidence: t.container.evidence },
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;
    const socket = connectClient(`${url}/chat`, {
      transports: ['websocket'],
      auth: { token: signAccessToken({ userId: customerId, role: 'CUSTOMER' }, ACCESS_SECRET) },
      reconnection: false,
      forceNew: true,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const ack = chatSendAckSchema.parse(
        await socket.timeout(5_000).emitWithAck('chat:new_message', {
          client_id: 'c-live',
          order_id: orderId,
          body: 'Sent live.',
        }),
      );
      const broadcast: ChatMessage | null = ack.ok ? ack.message : null;

      const res = await history(orderId, bearer(customerId));

      expect(bodyOf(chatHistoryResponseSchema, res).messages).toEqual([broadcast]);
    } finally {
      socket.disconnect();
      await realtime.close();
    }
  });
});

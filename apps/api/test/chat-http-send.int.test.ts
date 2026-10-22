import { randomUUID } from 'node:crypto';

import { disputes, users, vendors } from '@hamro-pasal/db';
import {
  chatHistoryResponseSchema,
  chatHttpSendResponseSchema,
  type ChatMessage,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import { createOrder, createUser, createVendor, markDelivered } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * 2026-10-21 (Task 5): POST /api/orders/:id/chat, the dispute chat over HTTP (the admin dashboard
 * has no socket). Same rules as `chat:new_message`; the stored message is handed to the /chat
 * room's broadcaster. No socket server is started: a recording emitter stands in for it.
 */
describe('POST /api/orders/:id/chat', () => {
  let t: TestApp;
  const emitted: { room: string; message: ChatMessage }[] = [];

  beforeAll(() => {
    t = buildTestApp();
    t.container.chatBroadcaster.attach({
      to: (room: string) => ({
        emit: (_event: string, message: ChatMessage) => {
          emitted.push({ room, message });
          return true;
        },
      }),
    });
  });

  afterAll(async () => {
    t.container.chatBroadcaster.attach(null);
    await t.container.close();
  });

  const db = () => t.container.db;

  async function named(role: UserRole, first: string, last: string): Promise<string> {
    const id = await createUser(db(), role);
    await db().update(users).set({ first_name: first, last_name: last }).where(eq(users.id, id));
    return id;
  }

  async function deliveredOrder() {
    const customerId = await named('CUSTOMER', 'Aarav', 'Sharma');
    const vendorId = await createVendor(db());
    const [vendor] = await db()
      .select({ userId: vendors.user_id })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    const vendorUserId = vendor?.userId ?? '';
    const order = await createOrder(db(), { vendorId, customerId });
    await markDelivered(db(), order.id);
    return { customerId, vendorUserId, orderId: order.id };
  }

  const send = (orderId: string, token: string, body: unknown) =>
    request(t.app)
      .post(`/api/orders/${orderId}/chat`)
      .set('authorization', token)
      .send(body as object);

  it('stores a message from either party, broadcasts it to the room, and lists it', async () => {
    const { customerId, vendorUserId, orderId } = await deliveredOrder();

    const fromCustomer = await send(orderId, bearer(customerId), {
      client_id: 'c-1',
      body: 'The jar arrived broken.',
    });
    const fromShop = await send(orderId, bearer(vendorUserId, 'VENDOR'), {
      client_id: 'v-1',
      body: 'Sorry, we will replace it.',
    });

    expect(fromCustomer.status).toBe(201);
    expect(fromShop.status).toBe(201);
    const sent = bodyOf(chatHttpSendResponseSchema, fromCustomer).message;
    expect(sent).toMatchObject({ body: 'The jar arrived broken.' });
    // The privacy filter: first name and role, never the last name or phone.
    expect(JSON.stringify(sent)).not.toContain('Sharma');
    expect(emitted.filter((e) => e.room.endsWith(orderId)).map((e) => e.message.body)).toEqual([
      'The jar arrived broken.',
      'Sorry, we will replace it.',
    ]);
    const history = await request(t.app)
      .get(`/api/orders/${orderId}/chat`)
      .set('authorization', bearer(customerId));
    expect(bodyOf(chatHistoryResponseSchema, history).messages.map((m) => m.body)).toEqual([
      'The jar arrived broken.',
      'Sorry, we will replace it.',
    ]);
  });

  it('returns the stored message for a retried client_id instead of a duplicate', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const first = await send(orderId, bearer(customerId), { client_id: 'same', body: 'Hello' });
    const again = await send(orderId, bearer(customerId), { client_id: 'same', body: 'Hello' });

    expect(bodyOf(chatHttpSendResponseSchema, again).message.id).toBe(
      bodyOf(chatHttpSendResponseSchema, first).message.id,
    );
    const history = await request(t.app)
      .get(`/api/orders/${orderId}/chat`)
      .set('authorization', bearer(customerId));
    expect(bodyOf(chatHistoryResponseSchema, history).messages).toHaveLength(1);
  });

  it('lets a Super Admin write only once the conversation is escalated', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const admin = bearer(await named('SUPER_ADMIN', 'Sita', 'Admin'), 'SUPER_ADMIN');
    await send(orderId, bearer(customerId), { client_id: 'c-1', body: 'Broken jar' });

    const early = await send(orderId, admin, { client_id: 'a-1', body: 'Looking into it' });
    expect([early.status, errorOf(early).code]).toEqual([404, 'ORDER_NOT_FOUND']);

    await db()
      .update(disputes)
      .set({
        status: 'ESCALATED',
        escalated_at: new Date(),
        escalated_by_user_id: customerId,
        escalation_reason: 'Broken jar',
      })
      .where(eq(disputes.order_id, orderId));
    const joined = await send(orderId, admin, { client_id: 'a-1', body: 'Looking into it' });
    expect(joined.status).toBe(201);
    expect(bodyOf(chatHttpSendResponseSchema, joined).message.sender.role).toBe('SUPER_ADMIN');
  });

  it('refuses an outsider, an empty message and an attachment that is not evidence', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const stranger = bearer(await createUser(db()));

    const outsider = await send(orderId, stranger, { client_id: 'x', body: 'Hi' });
    expect([outsider.status, errorOf(outsider).code]).toEqual([404, 'ORDER_NOT_FOUND']);
    const empty = await send(orderId, bearer(customerId), { client_id: 'e', body: '   ' });
    expect(empty.status).toBe(400);
    const foreign = await send(orderId, bearer(customerId), {
      client_id: 'f',
      body: '',
      attachments: [{ url: 'https://evil.example/x.jpg', content_type: 'image/jpeg' }],
    });
    expect(foreign.status).toBe(400);
    expect(
      (await send(randomUUID(), bearer(customerId), { client_id: 'n', body: 'Hi' })).status,
    ).toBe(404);
    expect((await request(t.app).post(`/api/orders/${orderId}/chat`).send({})).status).toBe(401);
  });
});

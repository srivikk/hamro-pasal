import { randomUUID } from 'node:crypto';

import {
  notificationMessages,
  recordNotificationMessage,
  users,
  type Database,
} from '@hamro-pasal/db';
import {
  meResponseSchema,
  notificationListResponseSchema,
  notificationReadResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Step 7.1 (SPEC core 11): GET / PATCH /api/me and the notification centre under /api/me.
 * Real Express + PostgreSQL.
 */
describe('GET / PATCH /api/me and the notification centre', () => {
  let t: TestApp;
  let db: Database;

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  const me = (token: string | null) => {
    const req = request(t.app).get('/api/me');
    return token === null ? req : req.set('authorization', token);
  };
  const patch = (token: string, body: unknown) =>
    request(t.app)
      .patch('/api/me')
      .set('authorization', token)
      .send(body as object);

  describe('the account', () => {
    it('answers the signed-in account with its defaults, for any role', async () => {
      for (const role of ['CUSTOMER', 'VENDOR', 'DRIVER', 'SUPER_ADMIN'] as const) {
        const id = await createUser(db, role);
        const res = await me(bearer(id, role));
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(bodyOf(meResponseSchema, res).user).toMatchObject({
          id,
          role,
          full_name: 'Test',
          email: null,
          profile_complete: true,
          language_preference: 'en',
          terms_accepted_at: null,
          whatsapp_opt_in: false,
          account_status: 'ACTIVE',
        });
      }
      expect((await me(null)).status).toBe(401);
    });

    it('splits a full name into first and last, so the chat keeps showing the first only', async () => {
      const id = await createUser(db);
      const res = await patch(bearer(id), { full_name: '  Sita   Kumari Gurung ' });

      expect(bodyOf(meResponseSchema, res).user).toMatchObject({
        full_name: 'Sita Kumari Gurung',
        profile_complete: true,
      });
      const [row] = await db.select().from(users).where(eq(users.id, id));
      expect(row).toMatchObject({ first_name: 'Sita', last_name: 'Kumari Gurung' });

      await patch(bearer(id), { full_name: 'Aarav' });
      const [single] = await db.select().from(users).where(eq(users.id, id));
      expect(single).toMatchObject({ first_name: 'Aarav', last_name: null });
    });

    it('changes only the keys sent, and stores the email lower-cased', async () => {
      const id = await createUser(db);
      await patch(bearer(id), { full_name: 'Sita Gurung', whatsapp_opt_in: true });

      const res = await patch(bearer(id), { email: ` Sita.${id.slice(0, 6)}@Example.COM ` });

      expect(bodyOf(meResponseSchema, res).user).toMatchObject({
        full_name: 'Sita Gurung',
        whatsapp_opt_in: true,
        email: `sita.${id.slice(0, 6)}@example.com`,
      });
      const cleared = await patch(bearer(id), { email: null, language_preference: 'ne' });
      expect(bodyOf(meResponseSchema, cleared).user).toMatchObject({
        email: null,
        language_preference: 'ne',
      });
    });

    it('answers 409 EMAIL_TAKEN for another account’s address, in any letter case', async () => {
      const [owner, other] = [await createUser(db), await createUser(db)];
      const email = `shared-${owner.slice(0, 8)}@example.com`;
      expect((await patch(bearer(owner), { email })).status).toBe(200);

      const res = await patch(bearer(other), { email: email.toUpperCase() });

      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('EMAIL_TAKEN');
      // The owner can send its own address again.
      expect((await patch(bearer(owner), { email })).status).toBe(200);
    });

    it('stamps the terms with the database clock, once', async () => {
      const id = await createUser(db);
      const first = bodyOf(meResponseSchema, await patch(bearer(id), { accept_terms: true }));
      expect(first.user.terms_accepted_at).not.toBeNull();

      const again = bodyOf(meResponseSchema, await patch(bearer(id), { accept_terms: true }));

      expect(again.user.terms_accepted_at).toBe(first.user.terms_accepted_at);
    });

    it('refuses an empty body, unknown keys, a refused consent and bad values', async () => {
      const token = bearer(await createUser(db));
      for (const body of [
        {},
        { accept_terms: false },
        { full_name: 'S' },
        { full_name: 'x'.repeat(81) },
        { email: 'not-an-address' },
        { language_preference: 'hi' },
        { whatsapp_opt_in: 'yes' },
        { role: 'SUPER_ADMIN' },
        { phone: '+9779800000001' },
        { terms_accepted_at: new Date().toISOString() },
      ]) {
        const res = await patch(token, body);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });

    it('answers 401 for a valid token whose account is gone', async () => {
      const res = await me(bearer(randomUUID()));
      expect(res.status).toBe(401);
    });
  });

  describe('the notification centre', () => {
    const list = (token: string, query = '') =>
      request(t.app).get(`/api/me/notifications${query}`).set('authorization', token);
    const read = (token: string, id: string) =>
      request(t.app).post(`/api/me/notifications/${id}/read`).set('authorization', token);
    const unread = async (token: string) =>
      (
        (await request(t.app).get('/api/me/notifications/unread-count').set('authorization', token))
          .body as { unread: number }
      ).unread;

    const toVendor = (userId: string, title = 'Your ad has ended') =>
      recordNotificationMessage(db, {
        audience: 'VENDOR',
        source: 'SYSTEM',
        title,
        body: 'Open Marketing to book your next ad.',
        data: { event_type: 'marketing.ad_ended' },
        recipientUserIds: [userId],
      });

    async function broadcast(title: string) {
      const admin = await createUser(db, 'SUPER_ADMIN');
      return recordNotificationMessage(db, {
        audience: 'ALL_CUSTOMERS',
        source: 'ADMIN',
        title,
        body: 'Shops near you have offers.',
        createdByUserId: admin,
        recipientUserIds: [],
      });
    }

    it('lists a vendor’s own messages, newest first, with nobody else’s', async () => {
      const vendorUser = await vendorUserIdOf(db, await createVendor(db));
      const other = await vendorUserIdOf(db, await createVendor(db));
      const older = await toVendor(vendorUser, 'First');
      const newer = await toVendor(vendorUser, 'Second');
      await toVendor(other, 'Not yours');

      const body = bodyOf(notificationListResponseSchema, await list(bearer(vendorUser, 'VENDOR')));

      expect(body.notifications.map((n) => n.id)).toEqual([newer.id, older.id]);
      expect(body.notifications[0]).toMatchObject({
        audience: 'VENDOR',
        source: 'SYSTEM',
        title: 'Second',
        data: { event_type: 'marketing.ad_ended' },
        read_at: null,
      });
      expect(body.next_cursor).toBeNull();
    });

    it('shows a broadcast to customers whose account existed when it was sent, never to vendors', async () => {
      const before = await createUser(db);
      const vendorUser = await vendorUserIdOf(db, await createVendor(db));
      const message = await broadcast(`Offers ${randomUUID().slice(0, 6)}`);
      // Signed up after the broadcast: it is not theirs (SPEC edge case 23).
      const after = await createUser(db);
      await db
        .update(users)
        .set({ created_at: sql`now() + interval '1 second'` })
        .where(eq(users.id, after));

      const ids = async (token: string) =>
        bodyOf(notificationListResponseSchema, await list(token)).notifications.map((n) => n.id);

      expect(await ids(bearer(before))).toContain(message.id);
      expect(await ids(bearer(after))).not.toContain(message.id);
      expect(await ids(bearer(vendorUser, 'VENDOR'))).not.toContain(message.id);
    });

    it('keeps read receipts per customer: one reading a broadcast does not read it for another', async () => {
      const [sita, aarav] = [await createUser(db), await createUser(db)];
      const message = await broadcast(`Read ${randomUUID().slice(0, 6)}`);
      const unreadBefore = await unread(bearer(sita));

      const res = await read(bearer(sita), message.id);
      const firstRead = bodyOf(notificationReadResponseSchema, res).notification.read_at;
      expect(firstRead).not.toBeNull();
      const again = await read(bearer(sita), message.id);

      expect(bodyOf(notificationReadResponseSchema, again).notification.read_at).toBe(firstRead);
      expect(await unread(bearer(sita))).toBe(unreadBefore - 1);
      const aaravView = bodyOf(notificationListResponseSchema, await list(bearer(aarav)));
      expect(aaravView.notifications.find((n) => n.id === message.id)?.read_at).toBeNull();
      // Stored once, whatever the number of readers.
      expect(
        await db.select().from(notificationMessages).where(eq(notificationMessages.id, message.id)),
      ).toHaveLength(1);
    });

    it('marks a targeted message read for its recipient only, and hides it from others', async () => {
      const vendorUser = await vendorUserIdOf(db, await createVendor(db));
      const stranger = await vendorUserIdOf(db, await createVendor(db));
      const { id } = await toVendor(vendorUser);

      const refused = await read(bearer(stranger, 'VENDOR'), id);
      expect(refused.status).toBe(404);
      expect(errorOf(refused).code).toBe('NOTIFICATION_NOT_FOUND');
      expect((await read(bearer(vendorUser, 'VENDOR'), randomUUID())).status).toBe(404);
      expect((await read(bearer(vendorUser, 'VENDOR'), 'not-a-uuid')).status).toBe(400);

      expect((await read(bearer(vendorUser, 'VENDOR'), id)).status).toBe(200);
      expect(await unread(bearer(vendorUser, 'VENDOR'))).toBe(0);
    });

    it('marks everything read at once, broadcasts included, and counts what it marked', async () => {
      const customer = await createUser(db);
      await recordNotificationMessage(db, {
        audience: 'CUSTOMER',
        source: 'SYSTEM',
        title: 'Back in stock',
        body: 'Basmati Rice is back.',
        recipientUserIds: [customer],
      });
      const shown = await unread(bearer(customer));
      expect(shown).toBeGreaterThanOrEqual(1);

      const res = await request(t.app)
        .post('/api/me/notifications/read-all')
        .set('authorization', bearer(customer));

      expect(res.body).toEqual({ marked: shown });
      expect(await unread(bearer(customer))).toBe(0);
      const repeat = await request(t.app)
        .post('/api/me/notifications/read-all')
        .set('authorization', bearer(customer));
      expect(repeat.body).toEqual({ marked: 0 });
    });

    it('pages with the cursor without a gap or a repeat, and refuses someone else’s cursor', async () => {
      const vendorUser = await vendorUserIdOf(db, await createVendor(db));
      const stranger = await vendorUserIdOf(db, await createVendor(db));
      const sent: string[] = [];
      for (let i = 0; i < 5; i++)
        sent.push((await toVendor(vendorUser, `Message ${String(i)}`)).id);
      const token = bearer(vendorUser, 'VENDOR');

      const pageAfter = async (cursor: string | null) =>
        bodyOf(
          notificationListResponseSchema,
          await list(token, `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`),
        );
      const seen: string[] = [];
      let page = await pageAfter(null);
      seen.push(...page.notifications.map((n) => n.id));
      while (page.next_cursor !== null) {
        page = await pageAfter(page.next_cursor);
        seen.push(...page.notifications.map((n) => n.id));
      }

      expect(seen).toEqual([...sent].reverse());
      const foreign = await list(bearer(stranger, 'VENDOR'), `?cursor=${sent[0] ?? ''}`);
      expect(foreign.status).toBe(400);
      expect(errorOf(foreign).code).toBe('INVALID_CURSOR');
      expect((await list(token, '?limit=51')).status).toBe(400);
    });
  });
});

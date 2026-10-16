import {
  auditLogs,
  notificationMessages,
  notificationRecipients,
  outboxEvents,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  adminNotificationListResponseSchema,
  adminNotificationSentResponseSchema,
  adminVendorSearchResponseSchema,
  notificationListResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Step 7.5 (SPEC core 11, verification 31): the Super Admin's vendor search and push. Real
 * Express + PostgreSQL.
 */
describe('Admin push API', () => {
  let t: TestApp;
  let db: Database;
  let admin: string;
  let adminId: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    admin = bearer(adminId, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await t.container.close();
  });

  /** A shop with a distinct name; answers its id, code and owner. */
  async function shop(name: string) {
    const vendorId = await createVendor(db);
    const [row] = await db
      .update(vendors)
      .set({ business_name: name })
      .where(eq(vendors.id, vendorId))
      .returning({ code: vendors.vendor_code });
    return { vendorId, code: row?.code ?? '', userId: await vendorUserIdOf(db, vendorId) };
  }

  const search = (q: string) =>
    request(t.app).get('/api/admin/vendors/search').query({ q }).set('authorization', admin);
  const send = (body: object) =>
    request(t.app).post('/api/admin/notifications').set('authorization', admin).send(body);
  const inboxOf = async (userId: string, role: 'VENDOR' | 'CUSTOMER') =>
    bodyOf(
      notificationListResponseSchema,
      await request(t.app).get('/api/me/notifications').set('authorization', bearer(userId, role)),
    ).notifications;

  describe('vendor search', () => {
    it('finds a shop by a misspelt name and always shows its Vendor Code', async () => {
      const unique = `Zqx${String(Date.now()).slice(-6)}`;
      const a = await shop(`${unique} Kirana Pasal`);
      const b = await shop(`${unique} Kirana Pasal Thamel`);

      const res = await search(`${unique} Kirana`);
      const found = bodyOf(adminVendorSearchResponseSchema, res).vendors;
      const mine = found.filter((v) => v.id === a.vendorId || v.id === b.vendorId);
      expect(mine).toHaveLength(2);
      for (const result of mine) {
        expect(result.vendor_code).toMatch(/^HPV-\d{5,}$/);
        expect(Object.keys(result).sort()).toEqual([
          'business_name',
          'id',
          'municipality_palika_string',
          'status',
          'vendor_code',
        ]);
      }
      // Two similar names, told apart by their codes.
      expect(new Set(mine.map((v) => v.vendor_code)).size).toBe(2);

      const typo = bodyOf(adminVendorSearchResponseSchema, await search(`${unique} Kirna Psal`));
      expect(typo.vendors.map((v) => v.id)).toContain(a.vendorId);
    });

    it('finds a shop by its Vendor Code, its prefix, or the bare number', async () => {
      const s = await shop('Code Search Pasal');
      const number = String(Number(s.code.slice(4)));

      for (const q of [s.code, s.code.toLowerCase(), s.code.replace('-', ''), number]) {
        const found = bodyOf(adminVendorSearchResponseSchema, await search(q)).vendors;
        expect(found[0]?.id).toBe(s.vendorId);
      }
    });

    it('is for a Super Admin only, and needs a query', async () => {
      const vendorToken = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
      expect(
        (
          await request(t.app)
            .get('/api/admin/vendors/search')
            .query({ q: 'pasal' })
            .set('authorization', vendorToken)
        ).status,
      ).toBe(403);
      expect((await search('   ')).status).toBe(400);
    });
  });

  describe('sending to chosen vendors', () => {
    it('reaches only the chosen shops, in their notification centre, audited and queued', async () => {
      const chosen = [await shop('Chosen One Pasal'), await shop('Chosen Two Pasal')];
      const other = await shop('Not Chosen Pasal');

      const res = await send({
        audience: 'VENDORS',
        vendor_ids: chosen.map((s) => s.vendorId),
        title: 'Festival hours',
        body: 'Please update your opening hours for Dashain.',
        deep_link: '/settings',
      });
      expect(res.status).toBe(202);
      const sent = bodyOf(adminNotificationSentResponseSchema, res);
      expect(sent.recipient_count).toBe(2);

      for (const s of chosen) {
        const [message] = await inboxOf(s.userId, 'VENDOR');
        expect(message).toMatchObject({
          id: sent.message_id,
          audience: 'VENDOR',
          source: 'ADMIN',
          title: 'Festival hours',
          data: { deep_link: '/settings' },
          read_at: null,
        });
      }
      expect((await inboxOf(other.userId, 'VENDOR')).map((m) => m.id)).not.toContain(
        sent.message_id,
      );
      const recipients = await db
        .select()
        .from(notificationRecipients)
        .where(eq(notificationRecipients.message_id, sent.message_id));
      expect(recipients).toHaveLength(2);

      const audit = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.action, 'NOTIFICATION_SENT'), eq(auditLogs.entity_id, sent.message_id)),
        );
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_user_id).toBe(adminId);
      const queued = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.event_type, 'notification.broadcast_requested'),
            eq(outboxEvents.aggregate_id, sent.message_id),
          ),
        );
      expect(queued[0]?.payload).toEqual({ message_id: sent.message_id, audience: 'VENDOR' });
    });

    it('takes up to 500 shops, refuses 501, repeats, and unknown shops', async () => {
      const ids = Array.from(
        { length: 501 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      const tooMany = await send({
        audience: 'VENDORS',
        vendor_ids: ids,
        title: 'Hi',
        body: 'Hello.',
      });
      expect(tooMany.status).toBe(400);

      const s = await shop('Repeat Pasal');
      const twice = await send({
        audience: 'VENDORS',
        vendor_ids: [s.vendorId, s.vendorId],
        title: 'Hi',
        body: 'Hello.',
      });
      expect(twice.status).toBe(400);

      const unknown = await send({
        audience: 'VENDORS',
        vendor_ids: [s.vendorId, ids[0]],
        title: 'Hi',
        body: 'Hello.',
      });
      expect(unknown.status).toBe(422);
      expect(errorOf(unknown)).toMatchObject({
        code: 'VENDOR_NOT_FOUND',
        details: { vendor_ids: [ids[0]] },
      });
    });

    it('sends to 500 shops at once', async () => {
      const many: string[] = [];
      // Named to sort last, so these shops do not crowd the name-ordered admin lists other tests read.
      for (let i = 0; i < 500; i += 1) {
        many.push(await createVendor(db, { businessName: `zzz Bulk Push Pasal ${String(i)}` }));
      }
      const res = await send({
        audience: 'VENDORS',
        vendor_ids: many,
        title: 'Bulk',
        body: 'To all 500.',
      });
      expect(res.status).toBe(202);
      expect(bodyOf(adminNotificationSentResponseSchema, res).recipient_count).toBe(500);
    }, 120_000);

    it('refuses a title over 60 characters and a link that is not an app path', async () => {
      const s = await shop('Limits Pasal');
      expect(
        (
          await send({
            audience: 'VENDORS',
            vendor_ids: [s.vendorId],
            title: 'x'.repeat(61),
            body: 'b',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await send({
            audience: 'VENDORS',
            vendor_ids: [s.vendorId],
            title: 'Hi',
            body: 'Hello.',
            deep_link: 'https://phish.example',
          })
        ).status,
      ).toBe(400);
    });
  });

  describe('broadcast to all customers', () => {
    it('is stored once, seen by every existing customer, and at most once per 10 minutes', async () => {
      const before = await createUser(db);
      const res = await send({
        audience: 'ALL_CUSTOMERS',
        title: 'Free delivery today',
        body: 'Every order over Rs. 500 ships free until midnight.',
      });
      expect(res.status).toBe(202);
      const sent = bodyOf(adminNotificationSentResponseSchema, res);
      expect(sent.recipient_count).toBeGreaterThan(0);

      expect((await inboxOf(before, 'CUSTOMER')).map((m) => m.id)).toContain(sent.message_id);
      // Stored once: no recipient rows for a broadcast.
      expect(
        await db
          .select()
          .from(notificationRecipients)
          .where(eq(notificationRecipients.message_id, sent.message_id)),
      ).toEqual([]);
      // A vendor is not a customer: not in its centre.
      const s = await shop('Broadcast Bystander Pasal');
      expect((await inboxOf(s.userId, 'VENDOR')).map((m) => m.id)).not.toContain(sent.message_id);

      const again = await send({ audience: 'ALL_CUSTOMERS', title: 'Again', body: 'Too soon.' });
      expect(again.status).toBe(429);
      expect(errorOf(again).code).toBe('BROADCAST_RATE_LIMITED');
      expect(
        (errorOf(again).details as { retry_after_seconds: number }).retry_after_seconds,
      ).toBeGreaterThan(0);
      const stored = await db
        .select()
        .from(notificationMessages)
        .where(eq(notificationMessages.title, 'Again'));
      expect(stored).toEqual([]);
    });
  });

  describe('history', () => {
    it('lists what was sent, newest first, with recipients and the push outcome', async () => {
      const s = await shop('History Pasal');
      const first = bodyOf(
        adminNotificationSentResponseSchema,
        await send({ audience: 'VENDORS', vendor_ids: [s.vendorId], title: 'First', body: 'One.' }),
      );
      const second = bodyOf(
        adminNotificationSentResponseSchema,
        await send({
          audience: 'VENDORS',
          vendor_ids: [s.vendorId],
          title: 'Second',
          body: 'Two.',
        }),
      );

      const page = bodyOf(
        adminNotificationListResponseSchema,
        await request(t.app)
          .get('/api/admin/notifications')
          .query({ limit: 1 })
          .set('authorization', admin),
      );
      expect(page.notifications[0]).toMatchObject({
        id: second.message_id,
        audience: 'VENDOR',
        recipient_count: 1,
        push_sent: null,
        push_completed_at: null,
        created_by_user_id: adminId,
      });
      const next = bodyOf(
        adminNotificationListResponseSchema,
        await request(t.app)
          .get('/api/admin/notifications')
          .query({ limit: 1, cursor: page.next_cursor ?? '' })
          .set('authorization', admin),
      );
      expect(next.notifications[0]?.id).toBe(first.message_id);
    });
  });
});

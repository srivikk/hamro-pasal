import { auditLogs, vendorOffers, type Database } from '@hamro-pasal/db';
import {
  MAX_LIVE_VENDOR_OFFERS,
  auditLogSchema,
  vendorOfferListResponseSchema,
  vendorOfferResponseSchema,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 32 on real PostgreSQL: a vendor's own offers (SPEC core 7). GET / POST
 * /api/vendor/offers and POST /api/vendor/offers/:id/end. Table and CRUD only: no order is priced
 * with an offer yet.
 */
describe('Vendor offers API', () => {
  let t: TestApp;
  let db: Database;

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop() {
    const vendorId = await createVendor(db);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const create = (token: string, body: unknown = { kind: 'PERCENTAGE', value: 10 }) =>
    request(t.app)
      .post('/api/vendor/offers')
      .set('authorization', token)
      .send(body as object);

  const list = (token: string) =>
    request(t.app).get('/api/vendor/offers').set('authorization', token);

  const end = (token: string, offerId: string) =>
    request(t.app).post(`/api/vendor/offers/${offerId}/end`).set('authorization', token);

  const created = async (token: string, body?: unknown) => {
    const res = await create(token, body);
    if (res.status !== 201) throw new Error(`offer not created: ${JSON.stringify(res.body)}`);
    return bodyOf(vendorOfferResponseSchema, res).offer;
  };

  const rowsOf = (vendorId: string) =>
    db
      .select()
      .from(vendorOffers)
      .where(eq(vendorOffers.vendor_id, vendorId))
      .orderBy(asc(vendorOffers.created_at));

  const auditOf = (offerId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entity_id, offerId))
      .orderBy(asc(auditLogs.occurred_at));

  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  describe('POST /api/vendor/offers', () => {
    it("creates a percentage offer for the caller's shop, running from now, and audits it", async () => {
      const { vendorId, userId, token } = await shop();
      const endsAt = inDays(7);

      const res = await create(token, {
        kind: 'PERCENTAGE',
        value: 20,
        max_discount_npr: 100,
        min_cart_npr: 500,
        ends_at: endsAt,
      });

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { offer } = bodyOf(vendorOfferResponseSchema, res);
      expect(offer).toMatchObject({
        kind: 'PERCENTAGE',
        value: 20,
        max_discount_npr: 100,
        min_cart_npr: 500,
        label: '20% OFF up to Rs. 100',
        ends_at: endsAt,
        status: 'ACTIVE',
        ended_at: null,
      });
      expect(Math.abs(Date.parse(offer.starts_at) - Date.now())).toBeLessThan(60_000);

      const [row] = await rowsOf(vendorId);
      expect(row).toMatchObject({
        id: offer.id,
        vendor_id: vendorId,
        created_by_user_id: userId,
        ended_at: null,
        ended_by_user_id: null,
      });

      const [entry] = (await auditOf(offer.id)).map((log) => auditLogSchema.parse(log));
      expect(entry).toMatchObject({
        action: 'VENDOR_OFFER_CREATED',
        entity_type: 'vendor_offer',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        vendor_id: vendorId,
        before_state: null,
        after_state: {
          kind: 'PERCENTAGE',
          value: 20,
          max_discount_npr: 100,
          min_cart_npr: 500,
          label: '20% OFF up to Rs. 100',
          ends_at: endsAt,
          ended_at: null,
        },
        request_id: res.headers['x-request-id'],
      });
    });

    it('creates a flat offer with its minimum cart, and fills the optional terms', async () => {
      const { token } = await shop();

      const flat = await created(token, { kind: 'FLAT', value: 100, min_cart_npr: 1000 });
      const plain = await created(token, { kind: 'PERCENTAGE', value: 12.5 });

      expect(flat).toMatchObject({
        label: 'Flat Rs. 100 OFF',
        min_cart_npr: 1000,
        max_discount_npr: null,
        ends_at: null,
      });
      expect(plain).toMatchObject({
        label: '12.5% OFF',
        min_cart_npr: 0,
        max_discount_npr: null,
        ends_at: null,
        status: 'ACTIVE',
      });
    });

    it.each([
      ['a flat discount above its minimum cart', { kind: 'FLAT', value: 100, min_cart_npr: 50 }],
      ['a flat discount with no minimum cart', { kind: 'FLAT', value: 100 }],
      [
        'a cap on a flat discount',
        { kind: 'FLAT', value: 50, min_cart_npr: 500, max_discount_npr: 20 },
      ],
      ['a percentage above 100', { kind: 'PERCENTAGE', value: 101 }],
      ['a value of zero', { kind: 'PERCENTAGE', value: 0 }],
      ['a fraction of a paisa', { kind: 'PERCENTAGE', value: 10.001 }],
      ['a malformed end', { kind: 'PERCENTAGE', value: 10, ends_at: 'tomorrow' }],
      ['no kind', { value: 10 }],
      [
        'a vendor id',
        { kind: 'PERCENTAGE', value: 10, vendor_id: '4a1c1d5e-8f0b-4c3a-9b7e-2d6f1a0c5e11' },
      ],
      ['a start date', { kind: 'PERCENTAGE', value: 10, starts_at: '2026-11-01T00:00:00.000Z' }],
      ['a status', { kind: 'PERCENTAGE', value: 10, status: 'ENDED' }],
      ['a label of its own', { kind: 'PERCENTAGE', value: 10, label: '90% OFF' }],
    ])('refuses %s and stores nothing', async (_name, body) => {
      const { vendorId, token } = await shop();

      const res = await create(token, body);

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect(await rowsOf(vendorId)).toEqual([]);
    });

    it('refuses an end that is not in the future', async () => {
      const { vendorId, token } = await shop();

      const res = await create(token, { kind: 'PERCENTAGE', value: 10, ends_at: inDays(-1) });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('OFFER_END_IN_PAST');
      expect(await rowsOf(vendorId)).toEqual([]);
    });

    it('stops at the limit of running offers, and frees a place when one is ended', async () => {
      const { vendorId, token } = await shop();
      const offers = [];
      for (let index = 0; index < MAX_LIVE_VENDOR_OFFERS; index += 1) {
        offers.push(await created(token, { kind: 'PERCENTAGE', value: index + 1 }));
      }

      const over = await create(token);
      expect(over.status).toBe(422);
      expect(errorOf(over)).toMatchObject({
        code: 'OFFER_LIMIT_REACHED',
        details: { max: MAX_LIVE_VENDOR_OFFERS },
      });
      expect(await rowsOf(vendorId)).toHaveLength(MAX_LIVE_VENDOR_OFFERS);

      expect((await end(token, offers[0]?.id ?? '')).status).toBe(200);
      expect((await create(token)).status).toBe(201);
      expect((await create(token)).status).toBe(422);
    });

    it('never passes the limit under simultaneous creates', async () => {
      const { vendorId, token } = await shop();

      const responses = await Promise.all(
        Array.from({ length: MAX_LIVE_VENDOR_OFFERS + 5 }, () => create(token)),
      );

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses.filter((status) => status === 201)).toHaveLength(MAX_LIVE_VENDOR_OFFERS);
      expect(statuses.filter((status) => status === 422)).toHaveLength(5);
      expect(await rowsOf(vendorId)).toHaveLength(MAX_LIVE_VENDOR_OFFERS);
    });
  });

  describe('GET /api/vendor/offers', () => {
    it("lists the shop's offers newest first, with the standing of each", async () => {
      const { vendorId, userId, token } = await shop();
      const other = await shop();
      await created(other.token);
      // One that ran its course: created a week ago, over since yesterday.
      await db.execute(
        sql`INSERT INTO vendor_offers
              (vendor_id, kind, value, label, starts_at, ends_at, created_by_user_id, created_at)
            VALUES (${vendorId}, 'PERCENTAGE', 5, '5% OFF', now() - interval '7 days',
                    now() - interval '1 day', ${userId}, now() - interval '7 days')`,
      );
      const cancelled = await created(token, { kind: 'FLAT', value: 50, min_cart_npr: 500 });
      await end(token, cancelled.id);
      const running = await created(token, { kind: 'PERCENTAGE', value: 15, ends_at: inDays(3) });

      const res = await list(token);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { offers } = bodyOf(vendorOfferListResponseSchema, res);
      expect(offers.map((offer) => [offer.label, offer.status])).toEqual([
        ['15% OFF', 'ACTIVE'],
        ['Flat Rs. 50 OFF', 'CANCELLED'],
        ['5% OFF', 'ENDED'],
      ]);
      expect(offers[0]?.id).toBe(running.id);
      expect(offers[1]?.ended_at).not.toBeNull();
      expect(offers[2]?.ended_at).toBeNull();
    });

    it('answers an empty list for a shop with no offer', async () => {
      const { token } = await shop();
      expect(bodyOf(vendorOfferListResponseSchema, await list(token))).toEqual({ offers: [] });
    });
  });

  describe('POST /api/vendor/offers/:id/end', () => {
    it('ends the offer, keeps its terms, and audits it', async () => {
      const { vendorId, userId, token } = await shop();
      const offer = await created(token, { kind: 'PERCENTAGE', value: 20, max_discount_npr: 100 });

      const res = await end(token, offer.id);

      expect(res.status).toBe(200);
      const ended = bodyOf(vendorOfferResponseSchema, res).offer;
      expect(ended).toEqual({ ...offer, status: 'CANCELLED', ended_at: ended.ended_at });
      expect(ended.ended_at).not.toBeNull();
      const [row] = await rowsOf(vendorId);
      expect(row).toMatchObject({ ended_by_user_id: userId, value: 20, max_discount_npr: 100 });

      const entries = (await auditOf(offer.id)).map((log) => auditLogSchema.parse(log));
      expect(entries.map((entry) => entry.action)).toEqual([
        'VENDOR_OFFER_CREATED',
        'VENDOR_OFFER_ENDED',
      ]);
      expect(entries[1]).toMatchObject({
        actor_user_id: userId,
        before_state: { label: '20% OFF up to Rs. 100', ended_at: null },
        after_state: { label: '20% OFF up to Rs. 100', ended_at: ended.ended_at },
      });
    });

    it('answers a repeat with the same offer and records nothing more', async () => {
      const { token } = await shop();
      const offer = await created(token);

      const first = bodyOf(vendorOfferResponseSchema, await end(token, offer.id)).offer;
      const again = await end(token, offer.id);

      expect(again.status).toBe(200);
      expect(bodyOf(vendorOfferResponseSchema, again).offer).toEqual(first);
      expect(await auditOf(offer.id)).toHaveLength(2);
    });

    it('ends once under five simultaneous presses', async () => {
      const { token } = await shop();
      const offer = await created(token);

      const responses = await Promise.all(Array.from({ length: 5 }, () => end(token, offer.id)));

      expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
      const endedAt = new Set(
        responses.map((res) => bodyOf(vendorOfferResponseSchema, res).offer.ended_at),
      );
      expect(endedAt.size).toBe(1);
      expect(await auditOf(offer.id)).toHaveLength(2);
    });

    it("hides another shop's offer and leaves it running", async () => {
      const mine = await shop();
      const other = await shop();
      const theirs = await created(other.token);

      const stolen = await end(mine.token, theirs.id);
      const unknown = await end(mine.token, '00000000-0000-4000-8000-000000000000');
      const malformed = await end(mine.token, 'not-an-id');

      expect([stolen.status, unknown.status, malformed.status]).toEqual([404, 404, 400]);
      expect(errorOf(stolen).code).toBe('OFFER_NOT_FOUND');
      expect(errorOf(unknown).code).toBe('OFFER_NOT_FOUND');
      expect((await rowsOf(other.vendorId))[0]?.ended_at).toBeNull();
      expect(bodyOf(vendorOfferListResponseSchema, await list(other.token)).offers[0]?.status).toBe(
        'ACTIVE',
      );
    });
  });

  describe('what the API does not offer', () => {
    it('has no route that edits or deletes an offer: a rule is ended and made anew', async () => {
      const { vendorId, token } = await shop();
      const offer = await created(token);

      for (const method of ['put', 'patch', 'delete'] as const) {
        const res = await request(t.app)
          [method](`/api/vendor/offers/${offer.id}`)
          .set('authorization', token)
          .send({ value: 90 });
        expect(res.status).toBe(404);
      }
      expect((await rowsOf(vendorId))[0]).toMatchObject({ value: 10, ended_at: null });
    });

    it('lets no admin create an offer for a shop', async () => {
      const { vendorId } = await shop();
      const admin = bearer(await createUser(db, 'SUPER_ADMIN'), 'SUPER_ADMIN');

      for (const path of [
        '/api/admin/offers',
        `/api/admin/vendors/${vendorId}/offers`,
        '/api/admin/vendor-offers',
      ]) {
        const res = await request(t.app)
          .post(path)
          .set('authorization', admin)
          .send({ vendor_id: vendorId, kind: 'PERCENTAGE', value: 50 });
        expect(res.status).toBe(404);
      }
      expect(await rowsOf(vendorId)).toEqual([]);
    });

    it('needs a vendor token on every route', async () => {
      const { vendorId, token } = await shop();
      const offer = await created(token);
      const calls = [
        () => request(t.app).get('/api/vendor/offers'),
        () => request(t.app).post('/api/vendor/offers').send({ kind: 'PERCENTAGE', value: 10 }),
        () => request(t.app).post(`/api/vendor/offers/${offer.id}/end`),
      ];

      for (const call of calls) {
        expect((await call()).status).toBe(401);
        for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] satisfies UserRole[]) {
          const res = await call().set('authorization', bearer(await createUser(db, role), role));
          expect(res.status).toBe(403);
        }
      }
      expect(await rowsOf(vendorId)).toHaveLength(1);
      expect((await rowsOf(vendorId))[0]?.ended_at).toBeNull();
    });

    it('answers 404 VENDOR_NOT_FOUND for a vendor account without a shop', async () => {
      const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');

      for (const res of [await list(shopless), await create(shopless)]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('VENDOR_NOT_FOUND');
      }
    });
  });
});

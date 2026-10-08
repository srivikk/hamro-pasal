import { randomUUID } from 'node:crypto';

import { adProducts, type Database } from '@hamro-pasal/db';
import { adPurchaseResponseSchema, feedResponseSchema } from '@hamro-pasal/shared-types';
import request from 'supertest';

import { createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, type TestApp } from './support/http';

const DAY_MS = 86_400_000;
// Biratnagar: no other suite places a shop here, so these are the nearest shops of the feed.
const HERE = { lat: 26.4525, lng: 87.2718 };

/**
 * Phase 28: sponsored feed listings (SPEC core 8, verification 9) over HTTP on real PostgreSQL.
 * Up to two shops with a running FEED_LISTING purchase lead "Delivers to you", flagged.
 */
describe('sponsored feed', () => {
  let t: TestApp;
  let db: Database;
  let productId: string;

  beforeAll(async () => {
    t = buildTestApp();
    db = t.container.db;
    const [product] = await db
      .insert(adProducts)
      .values({
        name: `Sponsored Search ${randomUUID()}`,
        slot: 'FEED_LISTING',
        billing_model: 'PER_ORDER_PREMIUM',
        price_npr: 25,
        duration_days: 7,
        created_by_user_id: await createUser(db, 'SUPER_ADMIN'),
      })
      .returning();
    productId = product?.id ?? '';
  });

  afterAll(async () => {
    await t.container.close();
  });

  /** A shop `metres` north of the customer, with a 5 km radius. */
  async function shopAt(metres: number) {
    const vendorId = await createVendor(db, {
      location: { x: HERE.lng, y: HERE.lat + metres / 111_320 },
    });
    return { vendorId, token: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }

  const advertise = async (token: string, startsInDays = 0) =>
    bodyOf(
      adPurchaseResponseSchema,
      await request(t.app)
        .post('/api/vendor/ads/purchases')
        .set('Authorization', token)
        .send({
          ad_product_id: productId,
          starts_at: new Date(Date.now() + startsInDays * DAY_MS).toISOString(),
          budget_npr: 500,
          idempotency_key: randomUUID(),
          agreed: true,
        }),
    ).purchase;

  it('puts the two nearest advertisers that deliver here first, flagged, and no one else', async () => {
    const plain = await shopAt(100);
    const first = await shopAt(300);
    const second = await shopAt(500);
    const third = await shopAt(700);
    const tooFar = await shopAt(20_000);
    const notYet = await shopAt(200);
    const withdrawn = await shopAt(250);
    for (const advertiser of [first, second, third, tooFar]) await advertise(advertiser.token);
    await advertise(notYet.token, 2);
    const cancelled = await advertise(withdrawn.token);
    await request(t.app)
      .post(`/api/vendor/ads/purchases/${cancelled.id}/cancel`)
      .set('Authorization', withdrawn.token)
      .expect(200);
    const mine = new Set(
      [plain, first, second, third, tooFar, notYet, withdrawn].map((shop) => shop.vendorId),
    );

    const res = await request(t.app).get('/api/vendors').query(HERE);

    expect(res.status).toBe(200);
    const feed = bodyOf(feedResponseSchema, res);
    const listed = feed.serviceable
      .filter((entry) => mine.has(entry.vendor.id))
      .map((entry) => [entry.vendor.id, entry.is_sponsored]);
    expect(listed).toEqual([
      [first.vendorId, true],
      [second.vendorId, true],
      // Everyone else by distance: a third advertiser keeps its place, unflagged.
      [plain.vendorId, false],
      [notYet.vendorId, false],
      [withdrawn.vendorId, false],
      [third.vendorId, false],
    ]);
    // The two sponsored shops lead the whole section, not only this test's shops.
    expect(feed.serviceable.slice(0, 2).map((entry) => entry.vendor.id)).toEqual([
      first.vendorId,
      second.vendorId,
    ]);
    expect(feed.serviceable.filter((entry) => entry.is_sponsored)).toHaveLength(2);
    // An ad never overrides delivery rules: out of range stays in Explore Further, unflagged.
    const far = feed.explore_further.find((entry) => entry.vendor.id === tooFar.vendorId);
    expect(far).toMatchObject({ serviceable: false, is_sponsored: false });
    expect(feed.explore_further.some((entry) => entry.is_sponsored)).toBe(false);
  });
});

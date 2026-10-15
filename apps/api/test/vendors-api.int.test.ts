import { randomUUID } from 'node:crypto';

import { products } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  feedResponseSchema,
  vendorMenuSchema,
  type FeedEntry,
  type GeoPoint,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  pointAtDistance,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Pokhara Lakeside. Every other suite places its vendors in Kathmandu, about 140 km away, so
 * this suite's radius assertions cannot be disturbed by their rows.
 */
const CUSTOMER: GeoPoint = { x: 83.9595, y: 28.2096 };
const POKHARA = 'Pokhara Metropolitan City';

/** GET /api/vendors and GET /api/vendors/:id/products over real Express + PostgreSQL/PostGIS. */
describe('vendors API', () => {
  let t: TestApp;
  let customerId: string;

  beforeAll(async () => {
    t = buildTestApp();
    customerId = await createUser(t.container.db);
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  const feed = (query: Record<string, string>, auth = bearer(customerId)) =>
    request(t.app).get('/api/vendors').query(query).set('authorization', auth);

  const menu = (vendorId: string, query: Record<string, string>) =>
    request(t.app)
      .get(`/api/vendors/${vendorId}/products`)
      .query(query)
      .set('authorization', bearer(customerId));

  const at = (point: GeoPoint = CUSTOMER) => ({ lat: String(point.y), lng: String(point.x) });

  /** A 5 km RADIUS_BOUND vendor exactly `distanceM` metres (geodesic) from the customer. */
  async function radiusVendorAt(distanceM: number, azimuthDeg = 90): Promise<string> {
    return createVendor(db(), {
      deliveryScope: 'RADIUS_BOUND',
      radiusKm: 5,
      palika: POKHARA,
      location: await pointAtDistance(db(), CUSTOMER, distanceM, azimuthDeg),
    });
  }

  function entryOf(entries: FeedEntry[], vendorId: string): FeedEntry | undefined {
    return entries.find((e) => e.vendor.id === vendorId);
  }

  function sectionOf(body: { serviceable: FeedEntry[]; explore_further: FeedEntry[] }, id: string) {
    if (entryOf(body.serviceable, id) !== undefined) return 'serviceable';
    if (entryOf(body.explore_further, id) !== undefined) return 'explore_further';
    return 'absent';
  }

  describe('GET /api/vendors', () => {
    it('applies the 10% GPS drift buffer: 5.4 km is serviceable, 5.501 km is not (5.0 km radius)', async () => {
      const inside = await radiusVendorAt(4_900, 0);
      const inBuffer = await radiusVendorAt(5_400, 90);
      const beyond = await radiusVendorAt(5_501, 180);

      const res = await feed(at());

      expect(res.status).toBe(200);
      const body = bodyOf(feedResponseSchema, res);
      expect(sectionOf(body, inside)).toBe('serviceable');
      expect(sectionOf(body, inBuffer)).toBe('serviceable');
      expect(sectionOf(body, beyond)).toBe('explore_further');
      expect(entryOf(body.serviceable, inBuffer)).toMatchObject({
        serviceable: true,
        distance_km: 5.4,
        vendor: { id: inBuffer, delivery_scope: 'RADIUS_BOUND', radius_km: 5 },
      });
      expect(entryOf(body.explore_further, beyond)).toMatchObject({
        serviceable: false,
        distance_km: 5.501,
      });
    });

    it('uses the same boundary on every bearing', async () => {
      const bearings = [45, 135, 225, 315];
      const pairs = await Promise.all(
        bearings.map(async (azimuth) => ({
          near: await radiusVendorAt(5_499, azimuth),
          far: await radiusVendorAt(5_502, azimuth),
        })),
      );

      const body = bodyOf(feedResponseSchema, await feed(at()));

      for (const { near, far } of pairs) {
        expect(sectionOf(body, near)).toBe('serviceable');
        expect(sectionOf(body, far)).toBe('explore_further');
      }
    });

    it('serves NATION_WIDE vendors everywhere and CITY_WIDE vendors only in their Palika', async () => {
      const kathmandu = { x: 85.3123, y: 27.7154 };
      const nationWide = await createVendor(db(), {
        deliveryScope: 'NATION_WIDE',
        location: kathmandu,
      });
      const cityWide = await createVendor(db(), {
        deliveryScope: 'CITY_WIDE',
        palika: POKHARA,
        location: await pointAtDistance(db(), CUSTOMER, 20_000),
      });
      // Another Palika's CITY_WIDE shop. Not on the Kathmandu point the other suites use for their
      // vendors: explore_further is capped at FEED_SECTION_LIMIT and sorted by distance, and a
      // shared database with 100+ vendors at that exact distance could push this one past the cap.
      const otherCity = await createVendor(db(), {
        deliveryScope: 'CITY_WIDE',
        palika: 'Kathmandu Metropolitan City',
        location: await pointAtDistance(db(), CUSTOMER, 60_000),
      });

      const inPokhara = bodyOf(
        feedResponseSchema,
        await feed({ ...at(), municipality_palika_string: POKHARA }),
      );
      const noPalika = bodyOf(feedResponseSchema, await feed(at()));

      expect(sectionOf(inPokhara, nationWide)).toBe('serviceable');
      expect(entryOf(inPokhara.serviceable, nationWide)?.distance_km).toBeGreaterThan(100);
      expect(sectionOf(inPokhara, cityWide)).toBe('serviceable');
      expect(sectionOf(inPokhara, otherCity)).toBe('explore_further');
      // Without the customer's Palika, a CITY_WIDE match cannot be established.
      expect(sectionOf(noPalika, cityWide)).toBe('explore_further');
      expect(sectionOf(noPalika, nationWide)).toBe('serviceable');
    });

    it('returns only LIVE vendors', async () => {
      const location = await pointAtDistance(db(), CUSTOMER, 1_000);
      const live = await createVendor(db(), { location });
      const approved = await createVendor(db(), { location, status: 'APPROVED' });
      const suspended = await createVendor(db(), { location, status: 'SUSPENDED' });
      const sandboxed = await createVendor(db(), {
        location,
        status: 'SANDBOXED',
        deliveryScope: 'NATION_WIDE',
      });

      const body = bodyOf(feedResponseSchema, await feed(at()));

      expect(sectionOf(body, live)).toBe('serviceable');
      expect(sectionOf(body, approved)).toBe('absent');
      expect(sectionOf(body, suspended)).toBe('absent');
      expect(sectionOf(body, sandboxed)).toBe('absent');
    });

    it('orders each section nearest first', async () => {
      await radiusVendorAt(3_000, 270);
      await radiusVendorAt(500, 270);

      const body = bodyOf(feedResponseSchema, await feed(at()));

      for (const section of [body.serviceable, body.explore_further]) {
        const distances = section.map((e) => e.distance_km);
        expect(distances).toEqual([...distances].sort((a, b) => a - b));
      }
      expect(body.serviceable.every((e) => e.serviceable)).toBe(true);
      expect(body.explore_further.every((e) => !e.serviceable)).toBe(true);
    });

    it('rejects missing or non-Nepal coordinates', async () => {
      const missing = await feed({ lat: '28.2' });
      const london = await feed({ lat: '51.5072', lng: '-0.1276' });
      const garbage = await feed({ lat: 'north', lng: '83.9' });

      for (const res of [missing, london, garbage]) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });

    it('is public: a guest and any role get the feed without a customer token', async () => {
      const anonymous = await request(t.app).get('/api/vendors').query(at());
      const vendor = await feed(at(), bearer(randomUUID(), 'VENDOR'));

      expect([anonymous.status, vendor.status]).toEqual([200, 200]);
      feedResponseSchema.parse(anonymous.body);

      const vendorId = await radiusVendorAt(2_000);
      const guestMenu = await request(t.app).get(`/api/vendors/${vendorId}/products`).query(at());
      expect(guestMenu.status).toBe(200);
      vendorMenuSchema.parse(guestMenu.body);
    });
  });

  describe('GET /api/vendors/:id/products', () => {
    it('returns the active catalogue with real database ids, name-sorted, with the exact stock', async () => {
      const vendorId = await radiusVendorAt(2_000);
      const tea = await createProduct(db(), vendorId, 10, 450);
      const rice = await createProduct(db(), vendorId, 0, 1150);
      const retired = await createProduct(db(), vendorId, 5, 100);
      await db().update(products).set({ name: 'A Ilam Tea 500g' }).where(eq(products.id, tea));
      await db().update(products).set({ name: 'B Basmati Rice 5kg' }).where(eq(products.id, rice));
      await db().update(products).set({ is_active: false }).where(eq(products.id, retired));

      const res = await menu(vendorId, at());

      expect(res.status).toBe(200);
      const body = bodyOf(vendorMenuSchema, res);
      expect(body.vendor.id).toBe(vendorId);
      expect(body.serviceable).toBe(true);
      expect(body.products).toEqual([
        // Step 7.4: a guest waits for nothing.
        {
          id: tea,
          name: 'A Ilam Tea 500g',
          price_npr: 450,
          in_stock: true,
          stock_quantity: 10,
          is_alerted: false,
        },
        {
          id: rice,
          name: 'B Basmati Rice 5kg',
          price_npr: 1150,
          in_stock: false,
          stock_quantity: 0,
          is_alerted: false,
        },
      ]);
    });

    it('marks the menu of an out-of-range vendor as not serviceable', async () => {
      const vendorId = await radiusVendorAt(5_600);

      const body = bodyOf(vendorMenuSchema, await menu(vendorId, at()));

      expect(body.serviceable).toBe(false);
    });

    it('hides vendors that are not LIVE, and unknown vendors', async () => {
      const approved = await createVendor(db(), { status: 'APPROVED' });

      const hidden = await menu(approved, at());
      const unknown = await menu(randomUUID(), at());
      const malformed = await menu('not-a-uuid', at());

      expect([hidden.status, unknown.status, malformed.status]).toEqual([404, 404, 400]);
      expect(errorOf(hidden).code).toBe('VENDOR_NOT_FOUND');
      expect(errorOf(unknown).code).toBe('VENDOR_NOT_FOUND');
    });

    it('serves product ids that checkout accepts', async () => {
      const vendorId = await radiusVendorAt(1_500);
      await createProduct(db(), vendorId, 4, 300);
      const [product] = bodyOf(vendorMenuSchema, await menu(vendorId, at())).products;

      const res = await request(t.app)
        .post('/api/cart/checkout')
        .set('authorization', bearer(customerId))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'COD',
          items: [{ product_id: product?.id, quantity: 2 }],
          // Phase 25: checkout refuses an address outside the shop's delivery area, so the order
          // is delivered to the customer's own position (1.5 km from this 5 km shop).
          delivery_address: { ...DELIVERY_ADDRESS, exact_lat: CUSTOMER.y, exact_lng: CUSTOMER.x },
        });

      expect(res.status).toBe(201);
      expect(bodyOf(checkoutResponseSchema, res).order).toMatchObject({
        state: 'PLACED',
        subtotal_npr: 600,
      });
    });
  });
});

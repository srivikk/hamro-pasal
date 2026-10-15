import { auditLogs, orders, outboxEvents, vendors, type Database } from '@hamro-pasal/db';
import {
  availabilityResponseSchema,
  feedResponseSchema,
  openingHoursResponseSchema,
  type OpeningRange,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { nextBoundary } from '../src/vendor/vendor-availability-service';
import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

const WEEK = 7 * 1440;
const NEPAL_OFFSET_MS = (5 * 60 + 45) * 60_000;

/** Nepal minute of the week now. */
function nowMinute(): number {
  const local = new Date(Date.now() + NEPAL_OFFSET_MS);
  return local.getUTCDay() * 1440 + local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** A range starting `fromNow` minutes from now (negative: earlier), lasting `length` minutes. */
function rangeAt(fromNow: number, length: number): OpeningRange {
  const start = (((nowMinute() + fromNow) % WEEK) + WEEK) % WEEK;
  const end = (start + length) % 1440;
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return {
    weekday: Math.floor(start / 1440),
    opens_at: clock(start % 1440),
    closes_at: clock(end),
  };
}

/**
 * Step 7.3 (SPEC core 11): opening hours, the Open / Closed switch, the closed-shop refusal, and
 * Auto-Pause from rejected orders. Real Express + PostgreSQL.
 */
describe('Vendor opening hours, availability and Auto-Pause', () => {
  let t: TestApp;
  let db: Database;
  const SPOT = { x: 83.98, y: 28.21 };

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function shop() {
    const vendorId = await createVendor(db, { location: SPOT });
    return { vendorId, token: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }
  const putHours = (token: string, ranges: OpeningRange[]) =>
    request(t.app).put('/api/vendor/opening-hours').set('authorization', token).send({ ranges });
  const putMode = (token: string, mode: string) =>
    request(t.app).put('/api/vendor/availability').set('authorization', token).send({ mode });
  const availability = async (token: string) =>
    bodyOf(
      availabilityResponseSchema,
      await request(t.app).get('/api/vendor/availability').set('authorization', token),
    );
  const feedEntry = async (vendorId: string) => {
    const feed = bodyOf(
      feedResponseSchema,
      await request(t.app).get('/api/vendors').query({ lat: SPOT.y, lng: SPOT.x }),
    );
    return [...feed.serviceable, ...feed.explore_further].find((e) => e.vendor.id === vendorId);
  };
  async function checkout(vendorId: string) {
    const productId = await createProduct(db, vendorId, 20, 600);
    return request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(await createUser(db)))
      .send({
        idempotency_key: `hours-${productId}`,
        vendor_id: vendorId,
        payment_method: 'COD',
        items: [{ product_id: productId, quantity: 1 }],
        delivery_address: { ...DELIVERY_ADDRESS, exact_lat: SPOT.y, exact_lng: SPOT.x },
      });
  }

  describe('opening hours', () => {
    it('stores the week, answers it, and audits a change', async () => {
      const { vendorId, token } = await shop();
      const ranges = [
        { weekday: 1, opens_at: '08:00', closes_at: '20:00' },
        { weekday: 5, opens_at: '18:00', closes_at: '02:00' },
      ];

      const res = await putHours(token, ranges);

      expect(bodyOf(openingHoursResponseSchema, res)).toEqual({ vendor_id: vendorId, ranges });
      const again = await request(t.app)
        .get('/api/vendor/opening-hours')
        .set('authorization', token);
      expect(bodyOf(openingHoursResponseSchema, again).ranges).toEqual(ranges);
      const entries = await db
        .select()
        .from(auditLogs)
        .where(
          and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'OPENING_HOURS_CHANGED')),
        );
      expect(entries).toHaveLength(1);
      // The same week again changes and records nothing.
      await putHours(token, ranges);
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'OPENING_HOURS_CHANGED')),
          ),
      ).toHaveLength(1);
    });

    it('refuses overlaps (also across midnight), more than 3 ranges a day, and bad times', async () => {
      const { token } = await shop();
      for (const ranges of [
        [
          { weekday: 1, opens_at: '08:00', closes_at: '12:00' },
          { weekday: 1, opens_at: '11:00', closes_at: '14:00' },
        ],
        [
          { weekday: 6, opens_at: '22:00', closes_at: '02:00' },
          { weekday: 0, opens_at: '01:00', closes_at: '05:00' },
        ],
        Array.from({ length: 4 }, (_, i) => ({
          weekday: 2,
          opens_at: `0${String(i * 2)}:00`,
          closes_at: `0${String(i * 2 + 1)}:00`,
        })),
        [{ weekday: 1, opens_at: '9:00', closes_at: '17:00' }],
        [{ weekday: 7, opens_at: '09:00', closes_at: '17:00' }],
        [{ weekday: 1, opens_at: '09:00', closes_at: '09:00' }],
      ]) {
        const res = await putHours(token, ranges);
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('open or closed by the clock', () => {
    it('lists a shop inside its hours as open and takes its order', async () => {
      const { vendorId, token } = await shop();
      await putHours(token, [rangeAt(-60, 180)]);

      expect(await feedEntry(vendorId)).toMatchObject({ open_now: true, closed_reason: null });
      expect((await checkout(vendorId)).status).toBe(201);
    });

    it('lists a shop outside its hours as closed and refuses checkout with the reason', async () => {
      const { vendorId, token } = await shop();
      await putHours(token, [rangeAt(120, 60)]);

      expect(await feedEntry(vendorId)).toMatchObject({ open_now: false, closed_reason: 'HOURS' });
      const res = await checkout(vendorId);
      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'VENDOR_UNAVAILABLE',
        details: { reason: 'HOURS' },
      });
    });

    it('stops checkout 15 minutes before closing, and takes it again with time to spare', async () => {
      const closing = await shop();
      await putHours(closing.token, [rangeAt(-60, 70)]); // closes in 10 minutes
      expect((await checkout(closing.vendorId)).status).toBe(422);

      const overnight = await shop();
      await putHours(overnight.token, [rangeAt(-60, 180)]);
      expect(await feedEntry(overnight.vendorId)).toMatchObject({ open_now: true });
    });

    it('treats a shop without hours as open (the behaviour before step 7.3)', async () => {
      const { vendorId } = await shop();
      expect(await feedEntry(vendorId)).toMatchObject({ open_now: true, closed_reason: null });
    });
  });

  describe('the Open / Closed switch', () => {
    it('closes a shop without hours until switched back, and AUTO reopens it', async () => {
      const { vendorId, token } = await shop();

      const closed = bodyOf(availabilityResponseSchema, await putMode(token, 'CLOSED'));
      expect(closed).toMatchObject({
        mode: 'CLOSED',
        override_until: null,
        open_now: false,
        closed_reason: 'OVERRIDE',
      });
      expect(errorOf(await checkout(vendorId)).code).toBe('VENDOR_UNAVAILABLE');

      expect(bodyOf(availabilityResponseSchema, await putMode(token, 'AUTO'))).toMatchObject({
        mode: 'AUTO',
        open_now: true,
      });
      expect(
        await db
          .select()
          .from(auditLogs)
          .where(
            and(eq(auditLogs.entity_id, vendorId), eq(auditLogs.action, 'AVAILABILITY_CHANGED')),
          ),
      ).toHaveLength(2);
    });

    it('opens a shop outside its hours until the next scheduled boundary', async () => {
      const { token } = await shop();
      const ranges = [rangeAt(120, 60)];
      await putHours(token, ranges);

      const open = bodyOf(availabilityResponseSchema, await putMode(token, 'OPEN'));

      expect(open).toMatchObject({ mode: 'OPEN', open_now: true, has_hours: true });
      const until = new Date(open.override_until ?? 0).getTime();
      expect(Math.abs(until - (Date.now() + 120 * 60_000))).toBeLessThan(90_000);
    });

    it('lets the hours take over again once an override has run out', async () => {
      const { vendorId, token } = await shop();
      await putHours(token, [rangeAt(120, 60)]);
      await putMode(token, 'OPEN');
      await db
        .update(vendors)
        .set({ availability_override_until: sql`now() - interval '1 minute'` })
        .where(eq(vendors.id, vendorId));

      expect(await availability(token)).toMatchObject({ mode: 'AUTO', closed_reason: 'HOURS' });
    });

    it('refuses an unknown mode, and serves vendors only', async () => {
      const { token } = await shop();
      expect((await putMode(token, 'SOMETIMES')).status).toBe(400);
      expect(
        (
          await request(t.app)
            .get('/api/vendor/availability')
            .set('authorization', bearer(await createUser(db)))
        ).status,
      ).toBe(403);
    });
  });

  describe('Auto-Pause from rejections', () => {
    const reject = (token: string, orderId: string) =>
      request(t.app).post(`/api/vendors/orders/${orderId}/reject`).set('authorization', token);
    const accept = (token: string, orderId: string) =>
      request(t.app).post(`/api/vendors/orders/${orderId}/accept`).set('authorization', token);
    async function placedOrder(vendorId: string) {
      const order = await createOrder(db, { vendorId, customerId: await createUser(db) });
      await db
        .update(orders)
        .set({ state: 'PLACED', placed_at: sql`now()` })
        .where(eq(orders.id, order.id));
      return order.id;
    }

    it('pauses the shop at the third rejection in a row, once, and the vendor resumes it', async () => {
      const { vendorId, token } = await shop();
      for (let i = 0; i < 3; i++) {
        expect((await reject(token, await placedOrder(vendorId))).status).toBe(200);
      }

      expect(await availability(token)).toMatchObject({
        open_now: false,
        closed_reason: 'AUTO_PAUSED',
        consecutive_missed_orders: 3,
      });
      expect(await feedEntry(vendorId)).toMatchObject({ closed_reason: 'AUTO_PAUSED' });
      expect(errorOf(await checkout(vendorId))).toMatchObject({
        details: { reason: 'AUTO_PAUSED' },
      });
      const events = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregate_id, vendorId),
            eq(outboxEvents.event_type, 'vendor.auto_paused'),
          ),
        );
      expect(events).toHaveLength(1);
      expect((await db.select().from(vendors).where(eq(vendors.id, vendorId)))[0]?.status).toBe(
        'LIVE',
      );

      // CLOSED keeps it paused; AUTO resumes it and clears the count.
      expect(
        bodyOf(availabilityResponseSchema, await putMode(token, 'CLOSED')).auto_paused_at,
      ).not.toBeNull();
      expect(bodyOf(availabilityResponseSchema, await putMode(token, 'AUTO'))).toMatchObject({
        auto_paused_at: null,
        consecutive_missed_orders: 0,
        open_now: true,
      });
    });

    it('resets the count when an order is accepted in between', async () => {
      const { vendorId, token } = await shop();
      await reject(token, await placedOrder(vendorId));
      await reject(token, await placedOrder(vendorId));
      expect((await accept(token, await placedOrder(vendorId))).status).toBe(200);
      await reject(token, await placedOrder(vendorId));

      expect(await availability(token)).toMatchObject({
        auto_paused_at: null,
        consecutive_missed_orders: 1,
      });
    });
  });

  describe('nextBoundary', () => {
    it('is the next opening or closing, wrapping round the week, and null without hours', () => {
      expect(nextBoundary([], new Date())).toBeNull();
      // Wednesday 2026-10-14 10:00 Nepal Time = 04:15 UTC.
      const now = new Date('2026-10-14T04:15:00.000Z');
      expect(
        nextBoundary([{ weekday: 3, opens_at: '09:00', closes_at: '18:00' }], now)?.toISOString(),
      ).toBe('2026-10-14T12:15:00.000Z'); // 18:00 the same day
      expect(
        nextBoundary([{ weekday: 1, opens_at: '09:00', closes_at: '10:00' }], now)?.toISOString(),
      ).toBe('2026-10-19T03:15:00.000Z'); // next Monday 09:00
    });
  });
});

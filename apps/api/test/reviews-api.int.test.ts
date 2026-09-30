import { randomUUID } from 'node:crypto';

import { orders, reviews, vendors } from '@hamro-pasal/db';
import { reviewSubmitResponseSchema, type OrderState } from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  markDelivered,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 9: POST /api/reviews and the double-blind quarantine (SPEC §6, verification test 4) on
 * real PostgreSQL. The vendor side has no route yet, so its reviews go through ReviewService.
 */
describe('reviews API', () => {
  let t: TestApp;

  beforeAll(() => {
    t = buildTestApp();
  });

  afterAll(async () => {
    await t.container.close();
  });

  const db = () => t.container.db;

  /** A customer, a vendor (and its user) and one of their orders, delivered `hoursAgo` hours ago. */
  async function deliveredOrder(hoursAgo = 1) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db());
    const [vendor] = await db()
      .select({ userId: vendors.user_id })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    const order = await createOrder(db(), { vendorId, customerId });
    await markDelivered(db(), order.id);
    await deliveredHoursAgo(order.id, hoursAgo);
    return { customerId, vendorId, vendorUserId: vendor?.userId ?? '', orderId: order.id };
  }

  async function deliveredHoursAgo(orderId: string, hours: number) {
    await db()
      .update(orders)
      .set({ delivered_at: sql`now() - make_interval(secs => ${hours * 3600}::float8)` })
      .where(eq(orders.id, orderId));
  }

  function review(customerId: string, body: Record<string, unknown>) {
    return request(t.app).post('/api/reviews').set('authorization', bearer(customerId)).send(body);
  }

  function vendorReview(orderId: string, vendorUserId: string, rating = 4) {
    return t.container.reviews.submit({
      orderId,
      direction: 'VENDOR_TO_CUSTOMER',
      authorUserId: vendorUserId,
      rating,
      feedback: null,
    });
  }

  async function rowsOf(orderId: string) {
    return db().select().from(reviews).where(eq(reviews.order_id, orderId));
  }

  describe('POST /api/reviews', () => {
    it('stores a customer review of a delivered order, quarantined', async () => {
      const { customerId, orderId } = await deliveredOrder();

      const res = await review(customerId, {
        order_id: orderId,
        rating: 5,
        feedback: '  Fresh saag, quick rider.  ',
      });

      expect(res.status).toBe(201);
      const body = bodyOf(reviewSubmitResponseSchema, res);
      expect(body.review).toMatchObject({
        order_id: orderId,
        direction: 'CUSTOMER_TO_VENDOR',
        rating: 5,
        feedback: 'Fresh saag, quick rider.',
        status: 'QUARANTINED',
        published_at: null,
      });
      const [row] = await rowsOf(orderId);
      expect(row).toMatchObject({
        id: body.review.id,
        is_published: false,
        published_at: null,
        comment: 'Fresh saag, quick rider.',
      });
    });

    it('accepts a review without feedback, and stores blank feedback as null', async () => {
      const first = await deliveredOrder();
      const second = await deliveredOrder();

      const none = await review(first.customerId, { order_id: first.orderId, rating: 3 });
      const blank = await review(second.customerId, {
        order_id: second.orderId,
        rating: 3,
        feedback: '   ',
      });

      expect(bodyOf(reviewSubmitResponseSchema, none).review.feedback).toBeNull();
      expect(bodyOf(reviewSubmitResponseSchema, blank).review.feedback).toBeNull();
      expect((await rowsOf(second.orderId))[0]?.comment).toBeNull();
    });

    it.each<OrderState>(['PENDING_PAYMENT', 'PLACED', 'PREPARING', 'OUT_FOR_DELIVERY', 'CANCELED'])(
      'refuses an order in state %s (409 ORDER_STATE_CONFLICT)',
      async (state) => {
        const customerId = await createUser(db());
        const vendorId = await createVendor(db());
        const order = await createOrder(db(), { vendorId, customerId });
        if (state !== 'PENDING_PAYMENT') {
          await db()
            .update(orders)
            .set({ state, placed_at: sql`now()` })
            .where(eq(orders.id, order.id));
        }

        const res = await review(customerId, { order_id: order.id, rating: 4 });

        expect(res.status).toBe(409);
        expect(errorOf(res)).toMatchObject({ code: 'ORDER_STATE_CONFLICT', details: { state } });
        expect(await rowsOf(order.id)).toEqual([]);
      },
    );

    it("answers 404 for another customer's order or an unknown one", async () => {
      const { orderId } = await deliveredOrder();
      const stranger = await createUser(db());

      const other = await review(stranger, { order_id: orderId, rating: 1 });
      const unknown = await review(stranger, { order_id: randomUUID(), rating: 1 });

      expect(other.status).toBe(404);
      expect(errorOf(other).code).toBe('ORDER_NOT_FOUND');
      expect(unknown.status).toBe(404);
      expect(await rowsOf(orderId)).toEqual([]);
    });

    it('refuses a second review of the same order with the first review id', async () => {
      const { customerId, orderId } = await deliveredOrder();
      const first = bodyOf(
        reviewSubmitResponseSchema,
        await review(customerId, { order_id: orderId, rating: 4 }),
      );

      const again = await review(customerId, { order_id: orderId, rating: 1 });

      expect(again.status).toBe(409);
      expect(errorOf(again)).toMatchObject({
        code: 'REVIEW_ALREADY_SUBMITTED',
        details: { review_id: first.review.id },
      });
      expect((await rowsOf(orderId)).map((row) => row.rating)).toEqual([4]);
    });

    it('accepts reviews just inside the 48 h window and refuses them after it', async () => {
      const inside = await deliveredOrder(47.9);
      const outside = await deliveredOrder(48.1);

      const ok = await review(inside.customerId, { order_id: inside.orderId, rating: 4 });
      const late = await review(outside.customerId, { order_id: outside.orderId, rating: 4 });

      expect(ok.status).toBe(201);
      expect(late.status).toBe(422);
      expect(errorOf(late).code).toBe('REVIEW_WINDOW_CLOSED');
    });

    it.each([
      ['rating 0', { rating: 0 }],
      ['rating 6', { rating: 6 }],
      ['a fractional rating', { rating: 4.5 }],
      ['feedback over 500 characters', { rating: 4, feedback: 'a'.repeat(501) }],
      ['a client-chosen publication flag', { rating: 4, is_published: true }],
    ])('rejects %s (400)', async (_label, fields) => {
      const { customerId, orderId } = await deliveredOrder();

      const res = await review(customerId, { order_id: orderId, ...fields });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('needs a customer access token', async () => {
      const { orderId, vendorUserId } = await deliveredOrder();

      const anonymous = await request(t.app)
        .post('/api/reviews')
        .send({ order_id: orderId, rating: 5 });
      const asVendor = await request(t.app)
        .post('/api/reviews')
        .set('authorization', bearer(vendorUserId, 'VENDOR'))
        .send({ order_id: orderId, rating: 5 });

      expect(anonymous.status).toBe(401);
      expect(asVendor.status).toBe(403);
    });
  });

  describe('double-blind quarantine (SPEC §6)', () => {
    it('publishes both reviews when the customer reviews after the vendor', async () => {
      const { customerId, vendorUserId, orderId } = await deliveredOrder();
      const vendorSide = await vendorReview(orderId, vendorUserId);
      expect(vendorSide.is_published).toBe(false);

      const res = await review(customerId, { order_id: orderId, rating: 5 });

      const body = bodyOf(reviewSubmitResponseSchema, res);
      expect(body.review.status).toBe('PUBLISHED');
      const rows = await rowsOf(orderId);
      expect(rows.map((row) => row.is_published)).toEqual([true, true]);
      // Both leave quarantine at the same instant.
      expect(rows[0]?.published_at?.getTime()).toBe(rows[1]?.published_at?.getTime());
      expect(body.review.published_at).toBe(rows[0]?.published_at?.toISOString());
    });

    it('publishes both reviews when the vendor reviews after the customer', async () => {
      const { customerId, vendorUserId, orderId } = await deliveredOrder();
      const customerSide = bodyOf(
        reviewSubmitResponseSchema,
        await review(customerId, { order_id: orderId, rating: 2 }),
      );
      expect(customerSide.review.status).toBe('QUARANTINED');

      const vendorSide = await vendorReview(orderId, vendorUserId);

      expect(vendorSide.is_published).toBe(true);
      expect((await rowsOf(orderId)).every((row) => row.is_published)).toBe(true);
    });

    it('serialises simultaneous customer and vendor reviews: both end up published', async () => {
      const orderIds = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const { customerId, vendorUserId, orderId } = await deliveredOrder();
          // Both through the service, so neither side has an HTTP head start.
          await Promise.all([
            t.container.reviews.submit({
              orderId,
              direction: 'CUSTOMER_TO_VENDOR',
              authorUserId: customerId,
              rating: 5,
              feedback: null,
            }),
            vendorReview(orderId, vendorUserId),
          ]);
          return orderId;
        }),
      );

      for (const orderId of orderIds) {
        const rows = await rowsOf(orderId);
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.is_published)).toBe(true);
      }
    });

    it('stores exactly one review under concurrent duplicate submissions', async () => {
      const { customerId, orderId } = await deliveredOrder();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => review(customerId, { order_id: orderId, rating: 4 })),
      );

      expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(await rowsOf(orderId)).toHaveLength(1);
    });

    it('only the vendor of the order can post the vendor side', async () => {
      const { orderId } = await deliveredOrder();
      const otherVendorUser = await createUser(db(), 'VENDOR');

      await expect(vendorReview(orderId, otherVendorUser)).rejects.toThrow('not found');
    });

    describe('fetching a review (SPEC verification test 4)', () => {
      it('is hidden while only one side has reviewed and less than 48 h have passed', async () => {
        const { customerId, orderId } = await deliveredOrder(47);
        await review(customerId, { order_id: orderId, rating: 5 });

        await expect(
          t.container.reviews.publicReview(orderId, 'CUSTOMER_TO_VENDOR'),
        ).resolves.toBeNull();
      });

      it('is returned once both sides have reviewed', async () => {
        const { customerId, vendorUserId, orderId } = await deliveredOrder();
        await review(customerId, { order_id: orderId, rating: 5 });
        await vendorReview(orderId, vendorUserId, 2);

        const customerSide = await t.container.reviews.publicReview(orderId, 'CUSTOMER_TO_VENDOR');
        const vendorSide = await t.container.reviews.publicReview(orderId, 'VENDOR_TO_CUSTOMER');

        expect(customerSide?.rating).toBe(5);
        expect(vendorSide?.rating).toBe(2);
      });

      it('is returned once 48 h have passed since delivery, even if only one side reviewed', async () => {
        const { customerId, orderId } = await deliveredOrder(47);
        await review(customerId, { order_id: orderId, rating: 5 });
        await deliveredHoursAgo(orderId, 48.01);

        const customerSide = await t.container.reviews.publicReview(orderId, 'CUSTOMER_TO_VENDOR');

        expect(customerSide?.rating).toBe(5);
        await expect(
          t.container.reviews.publicReview(orderId, 'VENDOR_TO_CUSTOMER'),
        ).resolves.toBeNull(); // never written
      });
    });

    it('a quarantined low rating does not cost the customer COD until it is public', async () => {
      const customerId = await createUser(db());
      const vendorId = await createVendor(db(), { minOrderValue: 0 });
      const [vendor] = await db()
        .select({ userId: vendors.user_id })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      const productId = await createProduct(db(), vendorId, 10, 500);
      const past = await createOrder(db(), { vendorId, customerId });
      await markDelivered(db(), past.id);
      await vendorReview(past.id, vendor?.userId ?? '', 1);

      const codCheckout = () =>
        request(t.app)
          .post('/api/cart/checkout')
          .set('authorization', bearer(customerId))
          .send({
            idempotency_key: randomUUID(),
            vendor_id: vendorId,
            payment_method: 'COD',
            items: [{ product_id: productId, quantity: 1 }],
            delivery_address: DELIVERY_ADDRESS,
          });

      const whileQuarantined = await codCheckout();
      await deliveredHoursAgo(past.id, 49);
      const afterWindow = await codCheckout();

      expect(whileQuarantined.status).toBe(201);
      expect(afterWindow.status).toBe(422);
      expect(errorOf(afterWindow).code).toBe('COD_NOT_AVAILABLE');
    });
  });
});

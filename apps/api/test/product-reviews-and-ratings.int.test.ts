import { orderItems, products, reviews, users, type Database } from '@hamro-pasal/db';
import {
  feedResponseSchema,
  productReviewListResponseSchema,
  productReviewResponseSchema,
  vendorMenuSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
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
 * 2026-10-21 (Task 5): verified-purchase product reviews, and the shop ratings the feed, the shop
 * page and the cards show, from published customer reviews only (no mock values).
 */
describe('product reviews and shop ratings', () => {
  let t: TestApp;
  let db: Database;

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function customer(firstName: string, lastName: string): Promise<string> {
    const id = await createUser(db);
    await db
      .update(users)
      .set({ first_name: firstName, last_name: lastName })
      .where(eq(users.id, id));
    return id;
  }

  /** An order of `customerId` holding the product, delivered unless told otherwise. */
  async function bought(customerId: string, vendorId: string, productId: string, delivered = true) {
    const order = await createOrder(db, { vendorId, customerId });
    await db.insert(orderItems).values({
      order_id: order.id,
      product_id: productId,
      product_name: 'Ilam Tea 500g',
      unit_price_npr: 450,
      quantity: 1,
    });
    if (delivered) await markDelivered(db, order.id);
    return order.id;
  }

  const review = (productId: string, token: string, body: unknown) =>
    request(t.app)
      .post(`/api/products/${productId}/reviews`)
      .set('authorization', token)
      .send(body as object);
  const listReviews = (productId: string, token?: string) => {
    const req = request(t.app).get(`/api/products/${productId}/reviews`);
    return token === undefined ? req : req.set('authorization', token);
  };

  it('takes a review only from a customer whose delivered order held the product', async () => {
    const vendorId = await createVendor(db);
    const productId = await createProduct(db, vendorId, 10, 450);
    const buyer = await customer('Aarav', 'Sharma');
    const notYet = await customer('Sita', 'Rai');
    const stranger = await customer('Hari', 'Thapa');
    await bought(buyer, vendorId, productId);
    await bought(notYet, vendorId, productId, false);

    const ok = await review(productId, bearer(buyer), { rating: 4, comment: '  Fresh leaves. ' });
    expect(ok.status).toBe(201);
    expect(bodyOf(productReviewResponseSchema, ok).review).toMatchObject({
      rating: 4,
      comment: 'Fresh leaves.',
      reviewer_first_name: 'Aarav',
      verified_purchase: true,
    });
    for (const token of [bearer(notYet), bearer(stranger)]) {
      const refused = await review(productId, token, { rating: 5 });
      expect([refused.status, errorOf(refused).code]).toEqual([403, 'NOT_A_VERIFIED_PURCHASE']);
    }
    const vendorUser = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
    expect((await review(productId, vendorUser, { rating: 5 })).status).toBe(403);
  });

  it('keeps one review per customer and product: a second replaces the first', async () => {
    const vendorId = await createVendor(db);
    const productId = await createProduct(db, vendorId, 10, 450);
    const buyer = await customer('Aarav', 'Sharma');
    await bought(buyer, vendorId, productId);

    await review(productId, bearer(buyer), { rating: 2, comment: 'Stale' });
    await review(productId, bearer(buyer), { rating: 5 });

    const body = bodyOf(
      productReviewListResponseSchema,
      await listReviews(productId, bearer(buyer)),
    );
    expect(body.summary).toEqual({ average: 5, count: 1 });
    expect(body.reviews).toHaveLength(1);
    expect(body.viewer).toMatchObject({
      can_review: true,
      own_review: { rating: 5, comment: null },
    });
  });

  it('lists reviews newest first with the average, first names only, for guests too', async () => {
    const vendorId = await createVendor(db);
    const productId = await createProduct(db, vendorId, 10, 450);
    for (const [first, rating] of [
      ['Aarav', 5],
      ['Sita', 4],
      ['Hari', 4],
    ] as const) {
      const id = await customer(first, 'Surname');
      await bought(id, vendorId, productId);
      await review(productId, bearer(id), { rating });
    }

    const res = await listReviews(productId);
    expect(res.status).toBe(200);
    const body = bodyOf(productReviewListResponseSchema, res);
    expect(body.summary).toEqual({ average: 4.3, count: 3 });
    expect(body.reviews.map((r) => r.reviewer_first_name)).toEqual(['Hari', 'Sita', 'Aarav']);
    expect(body.viewer).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Surname');
  });

  it('refuses a bad rating, and a hidden product is not found', async () => {
    const vendorId = await createVendor(db);
    const productId = await createProduct(db, vendorId, 10, 450);
    const buyer = await customer('Aarav', 'Sharma');
    await bought(buyer, vendorId, productId);
    for (const body of [
      { rating: 0 },
      { rating: 6 },
      { rating: 4.5 },
      { rating: 4, comment: 'x'.repeat(501) },
    ]) {
      expect((await review(productId, bearer(buyer), body)).status).toBe(400);
    }
    await db.update(products).set({ is_active: false }).where(eq(products.id, productId));
    expect((await listReviews(productId)).status).toBe(404);
  });

  it('gives a shop the average of its published customer ratings, in the feed and on its page', async () => {
    const vendorId = await createVendor(db);
    const productId = await createProduct(db, vendorId, 10, 450);
    const ratings: [number, boolean][] = [
      [5, true],
      [4, true],
      // Quarantined (double-blind, not yet published): not counted.
      [1, false],
    ];
    for (const [rating, published] of ratings) {
      const buyer = await customer('Aarav', 'Sharma');
      const orderId = await bought(buyer, vendorId, productId);
      await db.insert(reviews).values({
        order_id: orderId,
        direction: 'CUSTOMER_TO_VENDOR',
        rating,
        is_published: published,
        published_at: published ? new Date() : null,
      });
    }
    const query = { lat: DELIVERY_ADDRESS.exact_lat, lng: DELIVERY_ADDRESS.exact_lng };

    const menu = bodyOf(
      vendorMenuSchema,
      await request(t.app).get(`/api/vendors/${vendorId}/products`).query(query),
    );
    expect(menu.vendor).toMatchObject({ rating_average: 4.5, rating_count: 2 });
    const feed = bodyOf(feedResponseSchema, await request(t.app).get('/api/vendors').query(query));
    const entry = [...feed.serviceable, ...feed.explore_further].find(
      (e) => e.vendor.id === vendorId,
    );
    expect(entry?.vendor).toMatchObject({ rating_average: 4.5, rating_count: 2 });

    const unrated = await createVendor(db);
    const plain = bodyOf(
      vendorMenuSchema,
      await request(t.app).get(`/api/vendors/${unrated}/products`).query(query),
    );
    expect(plain.vendor).toMatchObject({ rating_average: null, rating_count: 0 });
  });
});

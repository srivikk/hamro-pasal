import { auditLogs, orderItems, productReviews, type Database } from '@hamro-pasal/db';
import {
  adminProductReviewListResponseSchema,
  adminProductReviewResponseSchema,
  productReviewListResponseSchema,
} from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createOrder,
  createProduct,
  createUser,
  createVendor,
  markDelivered,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * 2026-10-22 (Task 6): a Super Admin unpublishes a product review that breaks platform policy
 * (audited, with a reason) and can publish it again. A hidden review leaves the public list and the
 * product's average, and its author's edit does not bring it back.
 */
describe('product review moderation', () => {
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

  /** A product with a delivered order per rating, each buyer having reviewed it. */
  async function reviewed(ratings: readonly number[]) {
    const vendorId = await createVendor(db);
    const productId = await createProduct(db, vendorId, 10, 450);
    const buyers: string[] = [];
    const reviewIds: string[] = [];
    for (const rating of ratings) {
      const buyer = await createUser(db);
      const order = await createOrder(db, { vendorId, customerId: buyer });
      await db.insert(orderItems).values({
        order_id: order.id,
        product_id: productId,
        product_name: 'Ilam Tea 500g',
        unit_price_npr: 450,
        quantity: 1,
      });
      await markDelivered(db, order.id);
      const res = await request(t.app)
        .post(`/api/products/${productId}/reviews`)
        .set('authorization', bearer(buyer))
        .send({ rating, comment: `Rated ${String(rating)}` });
      expect(res.status).toBe(201);
      buyers.push(buyer);
      reviewIds.push((res.body as { review: { id: string } }).review.id);
    }
    return { vendorId, productId, buyers, reviewIds };
  }

  const moderate = (id: string, body: unknown, token = admin) =>
    request(t.app)
      .patch(`/api/admin/product-reviews/${id}`)
      .set('authorization', token)
      .send(body as object);
  const publicList = (productId: string, token?: string) => {
    const req = request(t.app).get(`/api/products/${productId}/reviews`);
    return token === undefined ? req : req.set('authorization', token);
  };

  it('hides a review: out of the list and the average, audited with the reason', async () => {
    const { vendorId, productId, buyers, reviewIds } = await reviewed([5, 1]);
    const [, abusive] = reviewIds as [string, string];

    const res = await moderate(abusive, {
      hidden: true,
      reason: '  Abusive language toward the shop. ',
    });
    expect(res.status).toBe(200);
    expect(bodyOf(adminProductReviewResponseSchema, res).review).toMatchObject({
      id: abusive,
      hidden: true,
      hidden_reason: 'Abusive language toward the shop.',
      vendor: { id: vendorId },
    });

    const list = bodyOf(productReviewListResponseSchema, await publicList(productId));
    expect(list.reviews.map((r) => r.id)).toEqual([reviewIds[0]]);
    expect(list.summary).toEqual({ average: 5, count: 1 });

    // Its author still sees their own review, marked hidden.
    const own = bodyOf(
      productReviewListResponseSchema,
      await publicList(productId, bearer(buyers[1] ?? '')),
    );
    expect(own.viewer).toMatchObject({ own_review: { id: abusive }, own_review_hidden: true });

    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entity_id, abusive), eq(auditLogs.action, 'PRODUCT_REVIEW_HIDDEN')));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: adminId,
      vendor_id: vendorId,
      before_state: { hidden: false, hidden_reason: null },
      after_state: { hidden: true, hidden_reason: 'Abusive language toward the shop.' },
    });
  });

  it('keeps a hidden review hidden when its author edits it', async () => {
    const { productId, buyers, reviewIds } = await reviewed([2]);
    const id = reviewIds[0] ?? '';
    await moderate(id, { hidden: true, reason: 'Contains a phone number.' });
    const edit = await request(t.app)
      .post(`/api/products/${productId}/reviews`)
      .set('authorization', bearer(buyers[0] ?? ''))
      .send({ rating: 3, comment: 'Edited' });
    expect(edit.status).toBe(201);
    expect(bodyOf(productReviewListResponseSchema, await publicList(productId)).reviews).toEqual(
      [],
    );
  });

  it('shows it again; a repeat changes and records nothing', async () => {
    const { productId, reviewIds } = await reviewed([4]);
    const id = reviewIds[0] ?? '';
    await moderate(id, { hidden: true, reason: 'Reported by the shop.' });
    await moderate(id, { hidden: true, reason: 'A second, different reason.' });
    const shown = await moderate(id, { hidden: false });
    expect(bodyOf(adminProductReviewResponseSchema, shown).review).toMatchObject({
      hidden: false,
      hidden_at: null,
      hidden_reason: null,
    });
    expect((await moderate(id, { hidden: false })).status).toBe(200);
    expect(
      bodyOf(productReviewListResponseSchema, await publicList(productId)).reviews.map((r) => r.id),
    ).toEqual([id]);

    const actions = (
      await db
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.entity_id, id))
    ).map((row) => row.action);
    expect(actions.sort()).toEqual(['PRODUCT_REVIEW_HIDDEN', 'PRODUCT_REVIEW_SHOWN']);
    const [row] = await db.select().from(productReviews).where(eq(productReviews.id, id));
    expect(row?.hidden_by_user_id).toBeNull();
  });

  it('five simultaneous hides record one entry', async () => {
    const { reviewIds } = await reviewed([1]);
    const id = reviewIds[0] ?? '';
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => moderate(id, { hidden: true, reason: 'Spam link inside.' })),
    );
    expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    const entries = await db.select().from(auditLogs).where(eq(auditLogs.entity_id, id));
    expect(entries).toHaveLength(1);
  });

  it('lists every review for the admin, filtered by state, paged', async () => {
    const { reviewIds } = await reviewed([5, 4, 3]);
    await moderate(reviewIds[1] ?? '', { hidden: true, reason: 'Off-topic advertising.' });

    const hidden = bodyOf(
      adminProductReviewListResponseSchema,
      await request(t.app)
        .get('/api/admin/product-reviews?status=HIDDEN&limit=100')
        .set('authorization', admin),
    );
    expect(hidden.reviews.every((r) => r.hidden)).toBe(true);
    expect(hidden.reviews.map((r) => r.id)).toContain(reviewIds[1]);

    const first = bodyOf(
      adminProductReviewListResponseSchema,
      await request(t.app).get('/api/admin/product-reviews?limit=2').set('authorization', admin),
    );
    expect(first.reviews).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = bodyOf(
      adminProductReviewListResponseSchema,
      await request(t.app)
        .get(`/api/admin/product-reviews?limit=2&cursor=${first.next_cursor ?? ''}`)
        .set('authorization', admin),
    );
    expect(second.reviews.map((r) => r.id)).not.toContain(first.reviews[0]?.id);

    const bad = await request(t.app)
      .get('/api/admin/product-reviews?cursor=00000000-0000-4000-8000-000000000000')
      .set('authorization', admin);
    expect([bad.status, errorOf(bad).code]).toEqual([400, 'INVALID_CURSOR']);
  });

  it('refuses a short reason, an unknown review and anyone but a Super Admin', async () => {
    const { reviewIds } = await reviewed([2]);
    const id = reviewIds[0] ?? '';
    for (const body of [{ hidden: true }, { hidden: true, reason: 'short' }, { hidden: 'yes' }]) {
      expect((await moderate(id, body)).status).toBe(400);
    }
    const missing = await moderate('00000000-0000-4000-8000-000000000000', { hidden: false });
    expect([missing.status, errorOf(missing).code]).toEqual([404, 'PRODUCT_REVIEW_NOT_FOUND']);
    for (const role of ['CUSTOMER', 'VENDOR'] as const) {
      const token = bearer(await createUser(db, role), role);
      expect((await moderate(id, { hidden: false }, token)).status).toBe(403);
      expect(
        (await request(t.app).get('/api/admin/product-reviews').set('authorization', token)).status,
      ).toBe(403);
    }
    expect((await request(t.app).get('/api/admin/product-reviews')).status).toBe(401);
  });

  it('refuses half-hidden rows in the database', async () => {
    const { reviewIds } = await reviewed([3]);
    await expect(
      db
        .update(productReviews)
        .set({ hidden_at: new Date() })
        .where(eq(productReviews.id, reviewIds[0] ?? '')),
    ).rejects.toThrow();
  });
});

import { outboxEvents, shopOpenAlerts, stockAlerts, vendors, type Database } from '@hamro-pasal/db';
import {
  alertListResponseSchema,
  alertResponseSchema,
  MAX_ALERTS_PER_USER,
  vendorMenuSchema,
} from '@hamro-pasal/shared-types';
import { and, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createProduct, createUser, createVendor, vendorUserIdOf } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Step 7.4 (SPEC core 11, Notify Me): the customer's requests, the menu flags, and the
 * `product.back_in_stock` / `vendor.opened` events. Real Express + PostgreSQL.
 */
describe('Notify Me API', () => {
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
    return { vendorId, vendorToken: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }
  const pause = (vendorId: string) =>
    db
      .update(vendors)
      .set({ auto_paused_at: new Date(), consecutive_missed_orders: 3 })
      .where(eq(vendors.id, vendorId));
  const backInStockEvents = async (productId: string) =>
    db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.event_type, 'product.back_in_stock'),
          eq(outboxEvents.aggregate_id, productId),
        ),
      );
  const menu = async (vendorId: string, token?: string) => {
    const req = request(t.app)
      .get(`/api/vendors/${vendorId}/products`)
      .query({ lat: SPOT.y, lng: SPOT.x });
    return bodyOf(
      vendorMenuSchema,
      await (token === undefined ? req : req.set('authorization', token)),
    );
  };

  describe('product requests', () => {
    it('waits for an out-of-stock product once, lists it, flags the menu and can be withdrawn', async () => {
      const { vendorId } = await shop();
      const productId = await createProduct(db, vendorId, 0);
      const customer = bearer(await createUser(db));

      const put = () =>
        request(t.app).put(`/api/me/alerts/products/${productId}`).set('authorization', customer);
      expect(bodyOf(alertResponseSchema, await put())).toEqual({ alerted: true });
      expect(bodyOf(alertResponseSchema, await put())).toEqual({ alerted: true });

      const list = bodyOf(
        alertListResponseSchema,
        await request(t.app).get('/api/me/alerts').set('authorization', customer),
      );
      expect(list.products).toHaveLength(1);
      expect(list.products[0]).toMatchObject({ product_id: productId, vendor_id: vendorId });
      expect(list.shops).toEqual([]);

      expect((await menu(vendorId, customer)).products[0]?.is_alerted).toBe(true);
      // A guest, and another customer, see no flag.
      expect((await menu(vendorId)).products[0]?.is_alerted).toBe(false);
      expect((await menu(vendorId, bearer(await createUser(db)))).products[0]?.is_alerted).toBe(
        false,
      );

      const del = await request(t.app)
        .delete(`/api/me/alerts/products/${productId}`)
        .set('authorization', customer);
      expect(bodyOf(alertResponseSchema, del)).toEqual({ alerted: false });
      expect((await menu(vendorId, customer)).products[0]?.is_alerted).toBe(false);
    });

    it('refuses a product in stock, an unknown one, and a vendor or guest caller', async () => {
      const { vendorId, vendorToken } = await shop();
      const inStock = await createProduct(db, vendorId, 5);
      const customer = bearer(await createUser(db));

      const res = await request(t.app)
        .put(`/api/me/alerts/products/${inStock}`)
        .set('authorization', customer);
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('ALREADY_AVAILABLE');

      const unknown = await request(t.app)
        .put('/api/me/alerts/products/00000000-0000-4000-8000-000000000000')
        .set('authorization', customer);
      expect(unknown.status).toBe(404);

      expect(
        (
          await request(t.app)
            .put(`/api/me/alerts/products/${inStock}`)
            .set('authorization', vendorToken)
        ).status,
      ).toBe(403);
      expect((await request(t.app).get('/api/me/alerts')).status).toBe(401);
    });

    it(`keeps at most ${String(MAX_ALERTS_PER_USER)} requests waiting, products and shops together`, async () => {
      const { vendorId } = await shop();
      const userId = await createUser(db);
      const customer = bearer(userId);
      const productIds: string[] = [];
      for (let i = 0; i < MAX_ALERTS_PER_USER; i += 1) {
        productIds.push(await createProduct(db, vendorId, 0));
      }
      await db
        .insert(stockAlerts)
        .values(productIds.slice(1).map((id) => ({ user_id: userId, product_id: id })));
      const closed = await shop();
      await pause(closed.vendorId);
      expect(
        (
          await request(t.app)
            .put(`/api/me/alerts/shops/${closed.vendorId}`)
            .set('authorization', customer)
        ).status,
      ).toBe(200);

      const res = await request(t.app)
        .put(`/api/me/alerts/products/${String(productIds[0])}`)
        .set('authorization', customer);
      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('ALERT_LIMIT_REACHED');
      // Asking again for one already waiting is still fine at the limit.
      expect(
        (
          await request(t.app)
            .put(`/api/me/alerts/products/${String(productIds[1])}`)
            .set('authorization', customer)
        ).status,
      ).toBe(200);
    });
  });

  describe('shop requests', () => {
    it('waits for a closed shop and refuses an open one', async () => {
      const { vendorId } = await shop();
      const customer = bearer(await createUser(db));
      const put = () =>
        request(t.app).put(`/api/me/alerts/shops/${vendorId}`).set('authorization', customer);

      const open = await put();
      expect(open.status).toBe(422);
      expect(errorOf(open).code).toBe('ALREADY_AVAILABLE');

      await pause(vendorId);
      expect(bodyOf(alertResponseSchema, await put())).toEqual({ alerted: true });
      expect((await menu(vendorId, customer)).is_alerted).toBe(true);
      const list = bodyOf(
        alertListResponseSchema,
        await request(t.app).get('/api/me/alerts').set('authorization', customer),
      );
      expect(list.shops.map((s) => s.vendor_id)).toEqual([vendorId]);

      await request(t.app)
        .delete(`/api/me/alerts/shops/${vendorId}`)
        .set('authorization', customer);
      expect(
        await db.select().from(shopOpenAlerts).where(eq(shopOpenAlerts.vendor_id, vendorId)),
      ).toEqual([]);
    });

    it('writes vendor.opened when the vendor resumes a paused shop, and not when it closes', async () => {
      const { vendorId, vendorToken } = await shop();
      await pause(vendorId);
      const opened = async () =>
        db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.event_type, 'vendor.opened'),
              eq(outboxEvents.aggregate_id, vendorId),
            ),
          );

      await request(t.app)
        .put('/api/vendor/availability')
        .set('authorization', vendorToken)
        .send({ mode: 'CLOSED' });
      expect(await opened()).toHaveLength(0);

      await request(t.app)
        .put('/api/vendor/availability')
        .set('authorization', vendorToken)
        .send({ mode: 'AUTO' });
      const events = await opened();
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ vendor_id: vendorId });
    });
  });

  describe('product.back_in_stock', () => {
    it('is written when the stock goes from 0 to more, once, in the same transaction', async () => {
      const { vendorId, vendorToken } = await shop();
      const productId = await createProduct(db, vendorId, 0);
      const setStock = (stock: number) =>
        request(t.app)
          .patch(`/api/vendor/products/${productId}/stock`)
          .set('authorization', vendorToken)
          .send({ stock_quantity: stock });

      expect((await setStock(4)).status).toBe(200);
      expect(await backInStockEvents(productId)).toHaveLength(1);
      expect((await backInStockEvents(productId))[0]?.payload).toEqual({
        product_id: productId,
        vendor_id: vendorId,
      });

      // Still in stock: no new event. Sold out and back: one more.
      await setStock(9);
      expect(await backInStockEvents(productId)).toHaveLength(1);
      await setStock(0);
      await setStock(1);
      expect(await backInStockEvents(productId)).toHaveLength(2);
    });

    it('is written when a hidden product with stock is shown again (vendor or admin)', async () => {
      const { vendorId } = await shop();
      const productId = await createProduct(db, vendorId, 3, 100, { is_active: false });
      const admin = bearer(await createUser(db, 'SUPER_ADMIN'), 'SUPER_ADMIN');

      const res = await request(t.app)
        .patch(`/api/admin/products/${productId}/active`)
        .set('authorization', admin)
        .send({ is_active: true });
      expect(res.status).toBe(200);
      expect(await backInStockEvents(productId)).toHaveLength(1);

      // Another shop's stock change is not found and writes nothing.
      const other = await shop();
      const foreign = await request(t.app)
        .patch(`/api/vendor/products/${productId}/stock`)
        .set('authorization', other.vendorToken)
        .send({ stock_quantity: 0 });
      expect(foreign.status).toBe(404);
      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregate_id, productId));
      expect(count).toBe(1);
    });
  });
});

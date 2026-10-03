import { randomUUID } from 'node:crypto';

import { orders, products, type Database } from '@hamro-pasal/db';
import {
  checkoutResponseSchema,
  vendorProductListResponseSchema,
  vendorProductResponseSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createCategory,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  stockOf,
  vendorUserIdOf,
  type VendorFixture,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 17: the vendor's own catalogue and stock (/api/vendor/products), and how a stock change
 * reaches checkout, on real Express + PostgreSQL + Redis.
 */
describe('Vendor products API', () => {
  let testApp: TestApp;
  let db: Database;
  let categoryId: string;

  beforeAll(async () => {
    testApp = buildTestApp();
    db = testApp.container.db;
    categoryId = await createCategory(db, { name: 'Tea & Coffee' });
  });

  afterAll(async () => {
    await testApp.container.close();
  });

  async function vendor(options: VendorFixture = {}) {
    const vendorId = await createVendor(db, options);
    return { vendorId, token: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }

  function create(token: string, body: Record<string, unknown>) {
    return request(testApp.app).post('/api/vendor/products').set('Authorization', token).send(body);
  }

  function setStock(token: string, productId: string, body: Record<string, unknown>) {
    return request(testApp.app)
      .patch(`/api/vendor/products/${productId}/stock`)
      .set('Authorization', token)
      .send(body);
  }

  function list(token: string, query: Record<string, string> = {}) {
    return request(testApp.app)
      .get('/api/vendor/products')
      .query(query)
      .set('Authorization', token);
  }

  function checkout(customerId: string, vendorId: string, productId: string, quantity: number) {
    return request(testApp.app)
      .post('/api/cart/checkout')
      .set('Authorization', bearer(customerId))
      .send({
        idempotency_key: randomUUID(),
        vendor_id: vendorId,
        payment_method: 'COD',
        items: [{ product_id: productId, quantity }],
        delivery_address: DELIVERY_ADDRESS,
      });
  }

  const tea = (extra: Record<string, unknown> = {}) => ({
    category_id: categoryId,
    name: `Ilam Tea ${randomUUID()}`,
    price_npr: 450,
    ...extra,
  });

  describe('POST /api/vendor/products', () => {
    it("creates a product of the caller's own shop, mapped to the category", async () => {
      const { vendorId, token } = await vendor();
      const body = tea({
        description: '  Orthodox black tea from Ilam.  ',
        unit: 'pack',
        stock_quantity: 60,
        image_urls: ['https://cdn.hamropasal.test/p/ilam-tea.webp'],
        metadata: { brand: 'Ilam', weight_g: 500 },
      });

      const res = await create(token, body);

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { product } = bodyOf(vendorProductResponseSchema, res);
      expect(product).toMatchObject({
        category_id: categoryId,
        name: body.name,
        description: 'Orthodox black tea from Ilam.',
        price_npr: 450,
        unit: 'pack',
        stock_quantity: 60,
        image_urls: ['https://cdn.hamropasal.test/p/ilam-tea.webp'],
        is_active: true,
        metadata: { brand: 'Ilam', weight_g: 500 },
      });
      const [row] = await db.select().from(products).where(eq(products.id, product.id));
      expect(row).toMatchObject({ vendor_id: vendorId, category_id: categoryId, unit: 'pack' });
    });

    it('defaults to one piece, no stock, no description', async () => {
      const { token } = await vendor();

      const res = await create(token, tea());

      expect(bodyOf(vendorProductResponseSchema, res).product).toMatchObject({
        description: null,
        unit: 'piece',
        stock_quantity: 0,
        image_urls: [],
        metadata: {},
      });
    });

    it('ignores any vendor named in the body: the shop comes from the token', async () => {
      const mine = await vendor();
      const other = await vendor();

      const res = await create(mine.token, { ...tea(), vendor_id: other.vendorId });

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    });

    it('lets a vendor that is not LIVE yet build its catalogue', async () => {
      for (const status of ['SANDBOXED', 'APPROVED'] as const) {
        const { token } = await vendor({ status });

        expect((await create(token, tea())).status).toBe(201);
      }
    });

    it('refuses a second product with the same name in one shop, not across shops', async () => {
      const first = await vendor();
      const second = await vendor();
      const body = tea();
      expect((await create(first.token, body)).status).toBe(201);

      const duplicate = await create(first.token, body);
      const otherShop = await create(second.token, body);

      expect(duplicate.status).toBe(409);
      expect(errorOf(duplicate).code).toBe('PRODUCT_NAME_TAKEN');
      expect(otherShop.status).toBe(201);
    });

    it('creates one product when the same name is submitted five times at once', async () => {
      const { vendorId, token } = await vendor();
      const body = tea();

      const responses = await Promise.all(Array.from({ length: 5 }, () => create(token, body)));

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      expect(await db.select().from(products).where(eq(products.vendor_id, vendorId))).toHaveLength(
        1,
      );
    });

    it('refuses an unknown or deactivated category', async () => {
      const { vendorId, token } = await vendor();
      const inactive = await createCategory(db, { isActive: false });

      const unknown = await create(token, tea({ category_id: randomUUID() }));
      const hidden = await create(token, tea({ category_id: inactive }));

      for (const res of [unknown, hidden]) {
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('CATEGORY_UNAVAILABLE');
      }
      expect(await db.select().from(products).where(eq(products.vendor_id, vendorId))).toHaveLength(
        0,
      );
    });

    it('validates the body', async () => {
      const { token } = await vendor();

      const bad = await Promise.all([
        create(token, { name: 'Tea', price_npr: 450 }),
        create(token, tea({ name: '   ' })),
        create(token, tea({ price_npr: 0 })),
        create(token, tea({ price_npr: 10.005 })),
        create(token, tea({ stock_quantity: -1 })),
        create(token, tea({ stock_quantity: 1.5 })),
        create(token, tea({ image_urls: ['ftp://example.test/a.png'] })),
        create(token, tea({ metadata: 'brand=Ilam' })),
      ]);

      for (const res of bad) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('PATCH /api/vendor/products/:id/stock', () => {
    it('sets the on-hand quantity and bumps updated_at', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 5);
      const [before] = await db.select().from(products).where(eq(products.id, productId));

      const res = await setStock(token, productId, { stock_quantity: 42 });

      expect(res.status).toBe(200);
      const { product } = bodyOf(vendorProductResponseSchema, res);
      expect(product).toMatchObject({ id: productId, stock_quantity: 42 });
      expect(await stockOf(db, productId)).toBe(42);
      expect(Date.parse(product.updated_at)).toBeGreaterThan(before?.updated_at.getTime() ?? 0);
    });

    it('can set the stock to zero, and changes nothing else', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 5, 250, { name: 'Unchanged' });

      const res = await setStock(token, productId, { stock_quantity: 0 });

      expect(res.status).toBe(200);
      const [row] = await db.select().from(products).where(eq(products.id, productId));
      expect(row).toMatchObject({
        name: 'Unchanged',
        price_npr: 250,
        stock_quantity: 0,
        is_active: true,
      });
    });

    it("treats another shop's product as not found and leaves it untouched", async () => {
      const mine = await vendor();
      const other = await vendor();
      const theirs = await createProduct(db, other.vendorId, 7);

      const res = await setStock(mine.token, theirs, { stock_quantity: 0 });

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRODUCT_NOT_FOUND');
      expect(await stockOf(db, theirs)).toBe(7);
    });

    it('answers 404 for an unknown product and 400 for a bad quantity, id or extra field', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 5);

      const unknown = await setStock(token, randomUUID(), { stock_quantity: 1 });
      const bad = await Promise.all([
        setStock(token, productId, { stock_quantity: -1 }),
        setStock(token, productId, { stock_quantity: 2.5 }),
        setStock(token, productId, { stock_quantity: '9' }),
        setStock(token, productId, {}),
        setStock(token, productId, { stock_quantity: 9, price_npr: 1 }),
        setStock(token, 'not-a-uuid', { stock_quantity: 9 }),
      ]);

      expect(unknown.status).toBe(404);
      for (const res of bad) expect(res.status).toBe(400);
      expect(await stockOf(db, productId)).toBe(5);
    });

    it('a sold-out product cannot be ordered until the vendor restocks it', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 3, 250);
      const customerId = await createUser(db);
      expect((await setStock(token, productId, { stock_quantity: 0 })).status).toBe(200);

      const soldOut = await checkout(customerId, vendorId, productId, 1);

      expect(soldOut.status).toBe(409);
      expect(errorOf(soldOut)).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
        details: { shortfalls: [{ productId, requested: 1, available: 0 }] },
      });

      expect((await setStock(token, productId, { stock_quantity: 2 })).status).toBe(200);
      const tooMany = await checkout(customerId, vendorId, productId, 3);
      const fits = await checkout(customerId, vendorId, productId, 2);

      expect(tooMany.status).toBe(409);
      expect(errorOf(tooMany).details).toEqual({
        shortfalls: [{ productId, requested: 3, available: 2 }],
      });
      expect(fits.status).toBe(201);
      expect(bodyOf(checkoutResponseSchema, fits).order.state).toBe('PLACED');
      // The placed order took the two units out of the stock the vendor set.
      expect(await stockOf(db, productId)).toBe(0);
    });

    it('lowering stock under a live checkout hold fails that order at its claim, never oversells', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 5, 250);
      const customerId = await createUser(db);
      // A prepaid checkout holds 4 units in Redis and waits for the gateway.
      const held = await request(testApp.app)
        .post('/api/cart/checkout')
        .set('Authorization', bearer(customerId))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'ESEWA',
          items: [{ product_id: productId, quantity: 4 }],
          delivery_address: DELIVERY_ADDRESS,
        });
      expect(held.status).toBe(201);
      const { order, reservation } = bodyOf(checkoutResponseSchema, held);
      expect((await setStock(token, productId, { stock_quantity: 1 })).status).toBe(200);
      await db.update(orders).set({ payment_status: 'PAID' }).where(eq(orders.id, order.id));

      await expect(
        testApp.container.checkout.claim({
          orderId: order.id,
          vendorId,
          reservationId: reservation.id ?? '',
        }),
      ).rejects.toMatchObject({ name: 'InsufficientStockError' });

      expect(await stockOf(db, productId)).toBe(1);
      const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
      expect(after?.state).toBe('PENDING_PAYMENT');
    });
  });

  describe('GET /api/vendor/products', () => {
    it("lists only the caller's products, inactive ones included, by name", async () => {
      const mine = await vendor();
      const other = await vendor();
      const cheese = await createProduct(db, mine.vendorId, 4, 300, { name: 'Cheese' });
      const apple = await createProduct(db, mine.vendorId, 0, 200, {
        name: 'Apple',
        is_active: false,
        category_id: categoryId,
      });
      await createProduct(db, other.vendorId, 9, 100, { name: 'Banana' });

      const res = await list(mine.token);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(vendorProductListResponseSchema, res);
      expect(body.next_cursor).toBeNull();
      expect(body.products.map((p) => p.id)).toEqual([apple, cheese]);
      expect(body.products[0]).toMatchObject({
        name: 'Apple',
        is_active: false,
        stock_quantity: 0,
        category_id: categoryId,
      });
      expect(body.products[1]).toMatchObject({ stock_quantity: 4, category_id: null });
    });

    it('pages 2 / 2 / 1 with the cursor, without gaps or repeats', async () => {
      const { vendorId, token } = await vendor();
      const ids: string[] = [];
      for (const name of ['A', 'B', 'C', 'D', 'E']) {
        ids.push(await createProduct(db, vendorId, 1, 100, { name }));
      }

      const first = bodyOf(vendorProductListResponseSchema, await list(token, { limit: '2' }));
      const second = bodyOf(
        vendorProductListResponseSchema,
        await list(token, { limit: '2', cursor: first.next_cursor ?? '' }),
      );
      const third = bodyOf(
        vendorProductListResponseSchema,
        await list(token, { limit: '2', cursor: second.next_cursor ?? '' }),
      );

      expect(first.products.map((p) => p.id)).toEqual(ids.slice(0, 2));
      expect(second.products.map((p) => p.id)).toEqual(ids.slice(2, 4));
      expect(third.products.map((p) => p.id)).toEqual(ids.slice(4));
      expect(first.next_cursor).toBe(ids[1]);
      expect(third.next_cursor).toBeNull();
    });

    it('is empty for a shop without products', async () => {
      const { token } = await vendor();

      expect(bodyOf(vendorProductListResponseSchema, await list(token))).toEqual({
        products: [],
        next_cursor: null,
      });
    });

    it("refuses a cursor that is another shop's product, an unknown one, and a bad limit", async () => {
      const mine = await vendor();
      const other = await vendor();
      const theirs = await createProduct(db, other.vendorId, 1);

      const foreign = await list(mine.token, { cursor: theirs });
      const unknown = await list(mine.token, { cursor: randomUUID() });
      const badLimit = await list(mine.token, { limit: '51' });

      for (const res of [foreign, unknown]) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('INVALID_CURSOR');
      }
      expect(badLimit.status).toBe(400);
      expect(errorOf(badLimit).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('roles', () => {
    it('serves vendors only, and a vendor account without a shop gets 404', async () => {
      const productId = await createProduct(db, await createVendor(db), 1);

      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as const) {
        const token = bearer(await createUser(db, role), role);
        const responses = await Promise.all([
          list(token),
          create(token, tea()),
          setStock(token, productId, { stock_quantity: 0 }),
        ]);
        for (const res of responses) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe('FORBIDDEN');
        }
      }
      const anonymous = await request(testApp.app).get('/api/vendor/products');
      expect(anonymous.status).toBe(401);

      const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
      for (const res of [
        await list(shopless),
        await create(shopless, tea()),
        await setStock(shopless, productId, { stock_quantity: 0 }),
      ]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('VENDOR_NOT_FOUND');
      }
      expect(await stockOf(db, productId)).toBe(1);
    });
  });
});

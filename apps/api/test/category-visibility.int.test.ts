import { randomUUID } from 'node:crypto';

import { categories, type Database } from '@hamro-pasal/db';
import { categoryListResponseSchema, productListResponseSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createCategory,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
  vendorUserIdOf,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Hierarchical category visibility (decided 2026-10-20) on real PostgreSQL: hiding a category hides
 * every category below it and every product filed anywhere in that subtree, from the customer
 * catalogue, the shop menu, the cart quote and checkout, and the vendor's category choice. Each
 * test builds its own three-level tree (Groceries › Tea & Coffee › Green Tea) and hides its root.
 */
describe('category visibility cascades down the tree', () => {
  let t: TestApp;
  let db: Database;

  beforeAll(() => {
    t = buildTestApp();
    db = t.container.db;
  });

  afterAll(async () => {
    await t.container.close();
  });

  async function tree() {
    const root = await createCategory(db, { name: 'Groceries' });
    const child = await createCategory(db, { name: 'Tea & Coffee', parentId: root });
    const grandchild = await createCategory(db, { name: 'Green Tea', parentId: child });
    const vendorId = await createVendor(db, { baseDeliveryFee: 50 });
    const product = (categoryId: string | null, name: string) =>
      createProduct(db, vendorId, 20, 400, {
        category_id: categoryId,
        name: `${name} ${randomUUID()}`,
      });
    return {
      root,
      child,
      grandchild,
      vendorId,
      inChild: await product(child, 'Ilam Tea'),
      inGrandchild: await product(grandchild, 'Green Tea Bags'),
      uncategorised: await product(null, 'Gift Bag'),
    };
  }

  const setActive = (categoryId: string, isActive: boolean) =>
    db.update(categories).set({ is_active: isActive }).where(eq(categories.id, categoryId));

  const listedCategoryIds = async () =>
    bodyOf(categoryListResponseSchema, await request(t.app).get('/api/categories')).categories.map(
      (category) => category.id,
    );

  const listedProductIds = async (query: Record<string, string>) => {
    const res = await request(t.app)
      .get('/api/products')
      .query({ limit: '50', ...query });
    return {
      res,
      ids:
        res.status === 200 ? bodyOf(productListResponseSchema, res).products.map((p) => p.id) : [],
    };
  };

  const menuProductIds = async (vendorId: string) => {
    const res = await request(t.app)
      .get(`/api/vendors/${vendorId}/products`)
      .query({ lat: '27.7149', lng: '85.3106' })
      .set('authorization', bearer(await createUser(db)));
    expect(res.status).toBe(200);
    return (res.body as { products: { id: string }[] }).products.map((p) => p.id);
  };

  const cartOf = (vendorId: string, productId: string) => ({
    vendor_id: vendorId,
    items: [{ product_id: productId, quantity: 1 }],
    delivery_address: DELIVERY_ADDRESS,
  });

  it('hides every category under a hidden one from GET /api/categories, and brings them back', async () => {
    const shop = await tree();
    expect(await listedCategoryIds()).toEqual(
      expect.arrayContaining([shop.root, shop.child, shop.grandchild]),
    );

    await setActive(shop.root, false);
    const hidden = await listedCategoryIds();
    for (const id of [shop.root, shop.child, shop.grandchild]) expect(hidden).not.toContain(id);

    // A middle category hidden on its own takes only its own subtree.
    await setActive(shop.root, true);
    await setActive(shop.child, false);
    const partly = await listedCategoryIds();
    expect(partly).toContain(shop.root);
    expect(partly).not.toContain(shop.child);
    expect(partly).not.toContain(shop.grandchild);
  });

  it('leaves out of GET /api/products every product under a hidden ancestor, filtered or not', async () => {
    const shop = await tree();
    const before = await listedProductIds({ vendor_id: shop.vendorId });
    expect(before.ids).toEqual(
      expect.arrayContaining([shop.inChild, shop.inGrandchild, shop.uncategorised]),
    );

    await setActive(shop.root, false);

    // Unfiltered: the grandchild's product is gone although its own category is still active.
    const after = await listedProductIds({ vendor_id: shop.vendorId });
    expect(after.ids).toEqual([shop.uncategorised]);
    // A category under the hidden root is not found, as a hidden one is.
    for (const categoryId of [shop.root, shop.child, shop.grandchild]) {
      const filtered = await listedProductIds({ category_id: categoryId });
      expect(filtered.res.status).toBe(404);
      expect(errorOf(filtered.res).code).toBe('CATEGORY_NOT_FOUND');
    }
    // Search does not find them either.
    const searched = await listedProductIds({ vendor_id: shop.vendorId, search: 'Green Tea' });
    expect(searched.ids).toEqual([]);

    await setActive(shop.root, true);
    expect((await listedProductIds({ category_id: shop.child })).ids.sort()).toEqual(
      [shop.inChild, shop.inGrandchild].sort(),
    );
  });

  it('leaves them out of the shop menu, GET /api/vendors/:id/products', async () => {
    const shop = await tree();
    await setActive(shop.child, false);

    expect(await menuProductIds(shop.vendorId)).toEqual([shop.uncategorised]);
  });

  it('blocks the quote and checkout of a cart item whose category was hidden after it was added', async () => {
    const shop = await tree();
    const customerId = await createUser(db);
    const quote = () =>
      request(t.app)
        .post('/api/cart/quote')
        .set('authorization', bearer(customerId))
        .send(cartOf(shop.vendorId, shop.inGrandchild));
    expect((await quote()).status).toBe(200);

    // The admin hides the root after the customer filled the cart.
    await setActive(shop.root, false);

    const refusedQuote = await quote();
    expect(refusedQuote.status).toBe(422);
    const [name] = await db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.id, shop.grandchild));
    expect(name?.name).toBe('Green Tea');
    const error = errorOf(refusedQuote);
    expect(error.code).toBe('CATEGORY_UNAVAILABLE');
    expect(error.message).toMatch(
      /^Item Green Tea Bags [0-9a-f-]+ belongs to an unavailable category$/,
    );
    expect(error.details).toMatchObject({ product_ids: [shop.inGrandchild] });

    const checkout = await request(t.app)
      .post('/api/cart/checkout')
      .set('authorization', bearer(customerId))
      .send({
        ...cartOf(shop.vendorId, shop.inGrandchild),
        idempotency_key: randomUUID(),
        payment_method: 'COD',
      });
    expect(checkout.status).toBe(422);
    expect(errorOf(checkout).code).toBe('CATEGORY_UNAVAILABLE');

    // A product without a category, and the cart once the root is shown again, go through.
    expect(
      (
        await request(t.app)
          .post('/api/cart/quote')
          .set('authorization', bearer(customerId))
          .send(cartOf(shop.vendorId, shop.uncategorised))
      ).status,
    ).toBe(200);
    await setActive(shop.root, true);
    expect((await quote()).status).toBe(200);
  });

  it('refuses a vendor filing a product under a hidden subtree, but lets one stay there', async () => {
    const shop = await tree();
    const token = bearer(await vendorUserIdOf(db, shop.vendorId), 'VENDOR');
    await setActive(shop.root, false);

    // The grandchild is active itself; its hidden root makes it unavailable.
    const created = await request(t.app)
      .post('/api/vendor/products')
      .set('authorization', token)
      .send({ category_id: shop.grandchild, name: `Matcha ${randomUUID()}`, price_npr: 900 });
    expect(created.status).toBe(422);
    expect(errorOf(created).code).toBe('CATEGORY_UNAVAILABLE');

    // A product already there may stay while its other details change.
    const kept = await request(t.app)
      .put(`/api/vendor/products/${shop.inGrandchild}`)
      .set('authorization', token)
      .send({
        category_id: shop.grandchild,
        name: `Green Tea Bags ${randomUUID()}`,
        price_npr: 450,
      });
    expect(kept.status).toBe(200);
  });
});

import { randomUUID } from 'node:crypto';

import { categories, products, type Database } from '@hamro-pasal/db';
import {
  adminCategoryListResponseSchema,
  adminCategoryResponseSchema,
  adminProductListResponseSchema,
  adminProductResponseSchema,
  categoryListResponseSchema,
  checkoutResponseSchema,
  productListResponseSchema,
  vendorMenuSchema,
  type AdminCategoryView,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import request from 'supertest';

import {
  createCategory,
  createProduct,
  createUser,
  createVendor,
  DELIVERY_ADDRESS,
} from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 17: the Super Admin's Master Category Taxonomy (POST/PUT/DELETE /api/admin/categories) and
 * the products overview, on real Express + PostgreSQL (foreign keys, unique slug, advisory lock).
 */
describe('Admin catalog API', () => {
  let testApp: TestApp;
  let db: Database;
  let admin: string;

  beforeAll(async () => {
    testApp = buildTestApp();
    db = testApp.container.db;
    admin = bearer(await createUser(db, 'SUPER_ADMIN'), 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await testApp.container.close();
  });

  const slug = (prefix = 'cat') => `${prefix}-${randomUUID()}`;

  function post(body: Record<string, unknown>, token = admin) {
    return request(testApp.app)
      .post('/api/admin/categories')
      .set('Authorization', token)
      .send(body);
  }

  function put(id: string, body: Record<string, unknown>, token = admin) {
    return request(testApp.app)
      .put(`/api/admin/categories/${id}`)
      .set('Authorization', token)
      .send(body);
  }

  function del(id: string, token = admin) {
    return request(testApp.app).delete(`/api/admin/categories/${id}`).set('Authorization', token);
  }

  /** Creates a category through the API and returns its view. */
  async function create(body: Record<string, unknown> = {}): Promise<AdminCategoryView> {
    const res = await post({ name: 'Category', slug: slug(), ...body });
    expect(res.status).toBe(201);
    return bodyOf(adminCategoryResponseSchema, res).category;
  }

  /** The admin list, limited to the given ids (the database is shared with other suites). */
  async function listed(ids: readonly string[]): Promise<AdminCategoryView[]> {
    const res = await request(testApp.app).get('/api/admin/categories').set('Authorization', admin);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return bodyOf(adminCategoryListResponseSchema, res).categories.filter((c) =>
      ids.includes(c.id),
    );
  }

  async function publicIds(ids: readonly string[]): Promise<string[]> {
    const res = await request(testApp.app).get('/api/categories');
    expect(res.status).toBe(200);
    return bodyOf(categoryListResponseSchema, res)
      .categories.map((c) => c.id)
      .filter((id) => ids.includes(id));
  }

  async function row(id: string) {
    const [found] = await db.select().from(categories).where(eq(categories.id, id));
    return found;
  }

  describe('POST /api/admin/categories', () => {
    it('creates a root category with the defaults and returns it', async () => {
      const mySlug = slug('groceries');

      const res = await post({ name: '  Groceries ', slug: mySlug });

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { category } = bodyOf(adminCategoryResponseSchema, res);
      expect(category).toMatchObject({
        name: 'Groceries',
        slug: mySlug,
        parent_id: null,
        icon_url: null,
        display_order: 0,
        is_active: true,
        product_count: 0,
      });
      expect(await row(category.id)).toMatchObject({ name: 'Groceries', slug: mySlug });
    });

    it('builds a three-level hierarchy, listed parent first and siblings by display_order', async () => {
      const root = await create({ name: 'Groceries' });
      const snacks = await create({ name: 'Snacks', parent_id: root.id, display_order: 2 });
      const dairy = await create({ name: 'Dairy', parent_id: root.id, display_order: 1 });
      const milk = await create({
        name: 'Milk',
        parent_id: dairy.id,
        icon_url: 'https://cdn.hamropasal.test/icons/milk.webp',
      });
      const ids = [root.id, snacks.id, dairy.id, milk.id];

      const list = await listed(ids);

      expect(list.map((c) => c.id)).toEqual([root.id, dairy.id, milk.id, snacks.id]);
      expect(list[2]).toMatchObject({
        parent_id: dairy.id,
        icon_url: 'https://cdn.hamropasal.test/icons/milk.webp',
      });
      // Customers see the same tree, without the admin-only fields.
      expect(await publicIds(ids)).toEqual([root.id, dairy.id, milk.id, snacks.id]);
    });

    it('refuses a fourth level', async () => {
      const root = await create();
      const child = await create({ parent_id: root.id });
      const grandchild = await create({ parent_id: child.id });

      const res = await post({ name: 'Too deep', slug: slug(), parent_id: grandchild.id });

      expect(res.status).toBe(422);
      expect(errorOf(res)).toMatchObject({ code: 'CATEGORY_TOO_DEEP', details: { max_depth: 3 } });
    });

    it('refuses an unknown parent', async () => {
      const res = await post({ name: 'Orphan', slug: slug(), parent_id: randomUUID() });

      expect(res.status).toBe(422);
      expect(errorOf(res).code).toBe('CATEGORY_PARENT_NOT_FOUND');
    });

    it('refuses a slug another category already uses', async () => {
      const existing = await create();

      const res = await post({ name: 'Copy', slug: existing.slug });

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'CATEGORY_SLUG_TAKEN',
        details: { slug: existing.slug },
      });
    });

    it('creates one category when the same slug is submitted five times at once', async () => {
      const mySlug = slug('race');

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => post({ name: 'Race', slug: mySlug })),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      const rows = await db.select().from(categories).where(eq(categories.slug, mySlug));
      expect(rows).toHaveLength(1);
    });

    it('validates the body', async () => {
      const bad = await Promise.all([
        post({ slug: slug() }),
        post({ name: '   ', slug: slug() }),
        post({ name: 'Dairy', slug: 'Dairy Products' }),
        post({ name: 'Dairy', slug: slug(), parent_id: 'nope' }),
        post({ name: 'Dairy', slug: slug(), icon_url: 'javascript:alert(1)' }),
        post({ name: 'Dairy', slug: slug(), display_order: -1 }),
        post({ name: 'Dairy', slug: slug(), product_count: 3 }),
      ]);

      for (const res of bad) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('PUT /api/admin/categories/:id', () => {
    it('replaces the editable fields and bumps updated_at', async () => {
      const category = await create({ name: 'Dairy', display_order: 4 });
      const newSlug = slug('dairy-eggs');

      const res = await put(category.id, {
        name: 'Dairy & Eggs',
        slug: newSlug,
        icon_url: 'https://cdn.hamropasal.test/icons/dairy.webp',
        display_order: 7,
        is_active: false,
      });

      expect(res.status).toBe(200);
      const updated = bodyOf(adminCategoryResponseSchema, res).category;
      expect(updated).toMatchObject({
        id: category.id,
        name: 'Dairy & Eggs',
        slug: newSlug,
        icon_url: 'https://cdn.hamropasal.test/icons/dairy.webp',
        display_order: 7,
        is_active: false,
      });
      expect(Date.parse(updated.updated_at)).toBeGreaterThan(Date.parse(category.updated_at));
      expect(updated.created_at).toBe(category.created_at);
    });

    it("keeps its own slug without a conflict, and refuses another category's", async () => {
      const first = await create();
      const second = await create();

      const same = await put(first.id, { name: 'Renamed', slug: first.slug });
      const taken = await put(first.id, { name: 'Renamed', slug: second.slug });

      expect(same.status).toBe(200);
      expect(taken.status).toBe(409);
      expect(errorOf(taken).code).toBe('CATEGORY_SLUG_TAKEN');
    });

    it('moves a category with its whole subtree', async () => {
      const groceries = await create({ name: 'Groceries' });
      const household = await create({ name: 'Household' });
      const dairy = await create({ name: 'Dairy', parent_id: groceries.id });
      const milk = await create({ name: 'Milk', parent_id: dairy.id });
      const ids = [groceries.id, household.id, dairy.id, milk.id];

      const res = await put(dairy.id, { name: 'Dairy', slug: dairy.slug, parent_id: household.id });

      expect(res.status).toBe(200);
      const list = await listed(ids);
      const position = (id: string) => list.findIndex((c) => c.id === id);
      expect(list.find((c) => c.id === dairy.id)?.parent_id).toBe(household.id);
      expect(list.find((c) => c.id === milk.id)?.parent_id).toBe(dairy.id);
      // Tree order: household, then dairy, then milk, consecutively.
      expect(position(dairy.id)).toBe(position(household.id) + 1);
      expect(position(milk.id)).toBe(position(dairy.id) + 1);
    });

    it('refuses to put a category under itself or under its own descendant', async () => {
      const root = await create();
      const child = await create({ parent_id: root.id });
      const grandchild = await create({ parent_id: child.id });

      const underSelf = await put(root.id, { name: 'X', slug: root.slug, parent_id: root.id });
      const underChild = await put(root.id, { name: 'X', slug: root.slug, parent_id: child.id });
      const underGrandchild = await put(root.id, {
        name: 'X',
        slug: root.slug,
        parent_id: grandchild.id,
      });

      for (const res of [underSelf, underChild, underGrandchild]) {
        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('CATEGORY_CYCLE');
      }
      expect((await row(root.id))?.parent_id).toBeNull();
    });

    it('counts the moved subtree against the depth limit', async () => {
      const tall = await create();
      const tallChild = await create({ parent_id: tall.id });
      const other = await create();
      const otherChild = await create({ parent_id: other.id });

      // tall + its child under a second level would end at level 4.
      const tooDeep = await put(tall.id, { name: 'X', slug: tall.slug, parent_id: otherChild.id });
      // The leaf alone fits there (level 3).
      const fits = await put(tallChild.id, {
        name: 'X',
        slug: tallChild.slug,
        parent_id: otherChild.id,
      });

      expect(tooDeep.status).toBe(422);
      expect(errorOf(tooDeep).code).toBe('CATEGORY_TOO_DEEP');
      expect(fits.status).toBe(200);
    });

    it('never lets two simultaneous opposite moves form a cycle', async () => {
      for (let round = 0; round < 5; round++) {
        const a = await create();
        const b = await create();

        const [aUnderB, bUnderA] = await Promise.all([
          put(a.id, { name: 'A', slug: a.slug, parent_id: b.id }),
          put(b.id, { name: 'B', slug: b.slug, parent_id: a.id }),
        ]);

        expect([aUnderB.status, bUnderA.status].sort()).toEqual([200, 409]);
        const [rowA, rowB] = [await row(a.id), await row(b.id)];
        expect(rowA?.parent_id === b.id && rowB?.parent_id === a.id).toBe(false);
      }
    });

    it('hides a deactivated category and its whole subtree from customers, not from the admin', async () => {
      const root = await create({ name: 'Seasonal' });
      const child = await create({ name: 'Dashain', parent_id: root.id });
      const sibling = await create({ name: 'Always' });
      const ids = [root.id, child.id, sibling.id];
      expect(await publicIds(ids)).toHaveLength(3);

      const res = await put(root.id, { name: 'Seasonal', slug: root.slug, is_active: false });

      expect(res.status).toBe(200);
      expect(await publicIds(ids)).toEqual([sibling.id]);
      expect((await listed(ids)).map((c) => [c.id, c.is_active])).toEqual(
        expect.arrayContaining([
          [root.id, false],
          [child.id, true],
          [sibling.id, true],
        ]),
      );
    });

    it('answers 404 for an unknown category and 400 for a malformed id or body', async () => {
      const unknown = await put(randomUUID(), { name: 'X', slug: slug() });
      const malformed = await put('not-a-uuid', { name: 'X', slug: slug() });
      const badBody = await put((await create()).id, { name: 'X' });

      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('CATEGORY_NOT_FOUND');
      expect(malformed.status).toBe(400);
      expect(badBody.status).toBe(400);
    });
  });

  describe('DELETE /api/admin/categories/:id', () => {
    it('removes an unused category', async () => {
      const category = await create();

      const res = await del(category.id);

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(await row(category.id)).toBeUndefined();
      expect((await del(category.id)).status).toBe(404);
    });

    it('refuses a category that still has subcategories', async () => {
      const root = await create();
      const child = await create({ parent_id: root.id });

      const res = await del(root.id);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'CATEGORY_IN_USE',
        details: { child_count: 1, product_count: 0 },
      });
      // Leaf first, then the parent.
      expect((await del(child.id)).status).toBe(204);
      expect((await del(root.id)).status).toBe(204);
    });

    it('refuses a category products are mapped to, and counts them in the list', async () => {
      const category = await create();
      const vendorId = await createVendor(db);
      await createProduct(db, vendorId, 5, 100, { category_id: category.id });
      await createProduct(db, vendorId, 0, 100, { category_id: category.id, is_active: false });

      const res = await del(category.id);

      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'CATEGORY_IN_USE',
        details: { child_count: 0, product_count: 2 },
      });
      expect((await listed([category.id]))[0]?.product_count).toBe(2);
      expect(await row(category.id)).toBeDefined();
    });

    it('is refused by the database itself when a product still points at the category', async () => {
      const categoryId = await createCategory(db);
      await createProduct(db, await createVendor(db), 1, 100, { category_id: categoryId });

      await expect(
        db.delete(categories).where(eq(categories.id, categoryId)),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          constraint: 'products_category_id_categories_id_fk',
        }) as unknown,
      });
    });

    it('answers 404 for an unknown category and 400 for a malformed id', async () => {
      expect((await del(randomUUID())).status).toBe(404);
      expect((await del('nope')).status).toBe(400);
    });
  });

  describe('roles', () => {
    it('serves the taxonomy routes to Super Admins only', async () => {
      const category = await create();
      const body = { name: 'X', slug: slug() };

      for (const role of ['CUSTOMER', 'VENDOR', 'DRIVER'] as const) {
        const token = bearer(await createUser(db, role), role);
        const responses = await Promise.all([
          request(testApp.app).get('/api/admin/categories').set('Authorization', token),
          post(body, token),
          put(category.id, body, token),
          del(category.id, token),
          request(testApp.app).get('/api/admin/products').set('Authorization', token),
          request(testApp.app)
            .patch(`/api/admin/products/${randomUUID()}/active`)
            .set('Authorization', token)
            .send({ is_active: false }),
        ]);
        for (const res of responses) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe('FORBIDDEN');
        }
      }
      const anonymous = await request(testApp.app).post('/api/admin/categories').send(body);
      expect(anonymous.status).toBe(401);
      expect(await row(category.id)).toMatchObject({ name: 'Category' });
    });
  });

  describe('GET /api/admin/products and PATCH /api/admin/products/:id/active', () => {
    function listProducts(query: Record<string, string>) {
      return request(testApp.app)
        .get('/api/admin/products')
        .query(query)
        .set('Authorization', admin);
    }

    function setActive(productId: string, isActive: unknown) {
      return request(testApp.app)
        .patch(`/api/admin/products/${productId}/active`)
        .set('Authorization', admin)
        .send({ is_active: isActive });
    }

    it("lists a vendor's products, inactive ones included, with vendor and category names", async () => {
      const categoryId = await createCategory(db, { name: 'Tea & Coffee' });
      const vendorId = await createVendor(db, {
        businessName: `Overview ${randomUUID()}`,
        status: 'APPROVED',
      });
      const tea = await createProduct(db, vendorId, 12, 450, {
        name: 'B Ilam Tea',
        category_id: categoryId,
        unit: 'pack',
      });
      const hidden = await createProduct(db, vendorId, 0, 90, {
        name: 'A Hidden Biscuit',
        is_active: false,
      });
      await createProduct(db, await createVendor(db), 1);

      const res = await listProducts({ vendor_id: vendorId });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = bodyOf(adminProductListResponseSchema, res);
      expect(body.next_cursor).toBeNull();
      expect(body.products.map((p) => p.id)).toEqual([hidden, tea]);
      expect(body.products[1]).toMatchObject({
        name: 'B Ilam Tea',
        price_npr: 450,
        unit: 'pack',
        stock_quantity: 12,
        is_active: true,
        category_id: categoryId,
        category_name: 'Tea & Coffee',
        vendor: { id: vendorId, status: 'APPROVED' },
      });
      expect(body.products[0]).toMatchObject({ is_active: false, category_name: null });
    });

    it('pages through every vendor without gaps or repeats', async () => {
      const prefix = `Paging ${randomUUID()}`;
      const expected: string[] = [];
      for (const vendorName of [`${prefix} A`, `${prefix} B`]) {
        const vendorId = await createVendor(db, { businessName: vendorName });
        for (const name of ['1 first', '2 second', '3 third']) {
          expected.push(await createProduct(db, vendorId, 1, 100, { name }));
        }
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 200; pageNumber++) {
        const res = await listProducts({ limit: '4', ...(cursor === undefined ? {} : { cursor }) });
        expect(res.status).toBe(200);
        const body = bodyOf(adminProductListResponseSchema, res);
        expect(body.products.length).toBeLessThanOrEqual(4);
        seen.push(...body.products.map((p) => p.id));
        if (body.next_cursor === null) break;
        cursor = body.next_cursor;
      }

      expect(new Set(seen).size).toBe(seen.length);
      // By vendor name, then product name.
      expect(seen.filter((id) => expected.includes(id))).toEqual(expected);
    });

    it('refuses an unknown cursor and a malformed query', async () => {
      const unknown = await listProducts({ cursor: randomUUID() });
      const malformed = await listProducts({ limit: '0' });
      const badVendor = await listProducts({ vendor_id: 'nope' });

      expect(unknown.status).toBe(400);
      expect(errorOf(unknown).code).toBe('INVALID_CURSOR');
      expect(malformed.status).toBe(400);
      expect(badVendor.status).toBe(400);
    });

    it('hides a product from customers and from checkout, then shows it again', async () => {
      const vendorId = await createVendor(db);
      const productId = await createProduct(db, vendorId, 10, 250);
      const customerId = await createUser(db);
      const customer = bearer(customerId);
      const publicList = async () =>
        bodyOf(
          productListResponseSchema,
          await request(testApp.app).get('/api/products').query({ vendor_id: vendorId }),
        ).products.map((p) => p.id);
      const menu = async () =>
        bodyOf(
          vendorMenuSchema,
          await request(testApp.app)
            .get(`/api/vendors/${vendorId}/products`)
            .query({ lat: '27.7149', lng: '85.3106' })
            .set('Authorization', customer),
        ).products.map((p) => p.id);
      const checkout = () =>
        request(testApp.app)
          .post('/api/cart/checkout')
          .set('Authorization', customer)
          .send({
            idempotency_key: randomUUID(),
            vendor_id: vendorId,
            payment_method: 'COD',
            items: [{ product_id: productId, quantity: 1 }],
            delivery_address: DELIVERY_ADDRESS,
          });
      expect(await publicList()).toEqual([productId]);

      const hidden = await setActive(productId, false);

      expect(hidden.status).toBe(200);
      expect(bodyOf(adminProductResponseSchema, hidden).product).toMatchObject({
        id: productId,
        is_active: false,
        stock_quantity: 10,
        vendor: { id: vendorId, status: 'LIVE' },
      });
      expect(await publicList()).toEqual([]);
      expect(await menu()).toEqual([]);
      const refused = await checkout();
      expect(refused.status).toBe(422);
      expect(errorOf(refused)).toMatchObject({
        code: 'PRODUCT_UNAVAILABLE',
        details: { product_ids: [productId] },
      });

      // Repeating the same toggle is harmless; showing it again restores everything.
      expect((await setActive(productId, false)).status).toBe(200);
      const shown = await setActive(productId, true);

      expect(bodyOf(adminProductResponseSchema, shown).product.is_active).toBe(true);
      expect(await publicList()).toEqual([productId]);
      expect(await menu()).toEqual([productId]);
      const placed = await checkout();
      expect(placed.status).toBe(201);
      expect(bodyOf(checkoutResponseSchema, placed).order.state).toBe('PLACED');
    });

    it('answers 404 for an unknown product and 400 for a bad body', async () => {
      const productId = await createProduct(db, await createVendor(db), 1);

      const unknown = await setActive(randomUUID(), false);
      const notBoolean = await setActive(productId, 'no');
      const extra = await request(testApp.app)
        .patch(`/api/admin/products/${productId}/active`)
        .set('Authorization', admin)
        .send({ is_active: false, stock_quantity: 0 });

      expect(unknown.status).toBe(404);
      expect(errorOf(unknown).code).toBe('PRODUCT_NOT_FOUND');
      expect(notBoolean.status).toBe(400);
      expect(extra.status).toBe(400);
      const [unchanged] = await db.select().from(products).where(eq(products.id, productId));
      expect(unchanged).toMatchObject({ is_active: true, stock_quantity: 1 });
    });
  });
});

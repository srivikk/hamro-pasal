import { randomBytes, randomUUID } from 'node:crypto';

import { type Database } from '@hamro-pasal/db';
import {
  categoryListResponseSchema,
  productListResponseSchema,
  type ProductListResponseBody,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import request from 'supertest';

import { createCategory, createProduct, createUser, createVendor } from './support/fixtures';
import { bearer, bodyOf, buildTestApp, errorOf, type TestApp } from './support/http';

/**
 * Phase 17: the public catalogue reads, GET /api/categories and GET /api/products (category
 * hierarchy, vendor and full-text filters, keyset pagination), on real Express + PostgreSQL.
 */
describe('Public catalog API', () => {
  let testApp: TestApp;
  let db: Database;

  beforeAll(() => {
    testApp = buildTestApp();
    db = testApp.container.db;
  });

  afterAll(async () => {
    await testApp.container.close();
  });

  /** A word no other test's products contain, so a search for it finds only this test's rows. */
  const marker = () => `zq${randomBytes(6).toString('hex')}`;

  function getProducts(query: Record<string, string>) {
    return request(testApp.app).get('/api/products').query(query);
  }

  async function products(query: Record<string, string>): Promise<ProductListResponseBody> {
    const res = await getProducts(query);
    expect(res.status).toBe(200);
    return bodyOf(productListResponseSchema, res);
  }

  const idsOf = (body: ProductListResponseBody) => body.products.map((p) => p.id);

  describe('GET /api/categories', () => {
    it('needs no token and returns the active tree, parents before children', async () => {
      const root = await createCategory(db, { name: 'Groceries' });
      const second = await createCategory(db, { name: 'Snacks', parentId: root, displayOrder: 2 });
      const first = await createCategory(db, { name: 'Dairy', parentId: root, displayOrder: 1 });
      const leaf = await createCategory(db, { name: 'Milk', parentId: first });
      const mine = [root, second, first, leaf];

      const res = await request(testApp.app).get('/api/categories');

      expect(res.status).toBe(200);
      const listed = bodyOf(categoryListResponseSchema, res).categories.filter((c) =>
        mine.includes(c.id),
      );
      expect(listed.map((c) => c.id)).toEqual([root, first, leaf, second]);
      expect(listed[1]).toEqual({
        id: first,
        name: 'Dairy',
        slug: expect.stringMatching(/^test-/) as unknown,
        parent_id: root,
        icon_url: null,
        display_order: 1,
      });
    });

    it('hides an inactive category together with everything under it', async () => {
      const hiddenRoot = await createCategory(db, { isActive: false });
      const underHidden = await createCategory(db, { parentId: hiddenRoot });
      const deepUnderHidden = await createCategory(db, { parentId: underHidden });
      const shownRoot = await createCategory(db);
      const hiddenLeaf = await createCategory(db, { parentId: shownRoot, isActive: false });

      const body = bodyOf(
        categoryListResponseSchema,
        await request(testApp.app).get('/api/categories'),
      );
      const ids = body.categories.map((c) => c.id);

      expect(ids).toContain(shownRoot);
      for (const hidden of [hiddenRoot, underHidden, deepUnderHidden, hiddenLeaf]) {
        expect(ids).not.toContain(hidden);
      }
    });

    it('serves every signed-in role as well', async () => {
      for (const role of ['CUSTOMER', 'VENDOR', 'DRIVER', 'SUPER_ADMIN'] as const) {
        const res = await request(testApp.app)
          .get('/api/categories')
          .set('Authorization', bearer(await createUser(db, role), role));

        expect(res.status).toBe(200);
      }
    });
  });

  describe('GET /api/products', () => {
    it('returns active products of LIVE vendors only, with the on-hand stock', async () => {
      const word = marker();
      const live = await createVendor(db, { businessName: 'Thamel Kirana Pasal' });
      const approved = await createVendor(db, { status: 'APPROVED' });
      const suspended = await createVendor(db, { status: 'SUSPENDED' });
      const categoryId = await createCategory(db);
      const inStock = await createProduct(db, live, 7, 450.5, {
        name: `${word} a tea`,
        description: 'Orthodox black tea.',
        unit: 'pack',
        category_id: categoryId,
        image_urls: ['https://cdn.hamropasal.test/p/tea.webp'],
        metadata: { brand: 'Ilam' },
      });
      const soldOut = await createProduct(db, live, 0, 100, { name: `${word} b sold out` });
      await createProduct(db, live, 5, 100, { name: `${word} c hidden`, is_active: false });
      await createProduct(db, approved, 5, 100, { name: `${word} d not live` });
      await createProduct(db, suspended, 5, 100, { name: `${word} e suspended` });

      const res = await getProducts({ search: word });

      expect(res.status).toBe(200);
      const body = bodyOf(productListResponseSchema, res);
      expect(idsOf(body)).toEqual([inStock, soldOut]);
      expect(body.next_cursor).toBeNull();
      expect(body.products[0]).toEqual({
        id: inStock,
        vendor: { id: live, business_name: 'Thamel Kirana Pasal' },
        category_id: categoryId,
        name: `${word} a tea`,
        description: 'Orthodox black tea.',
        price_npr: 450.5,
        unit: 'pack',
        in_stock: true,
        stock_quantity: 7,
        image_urls: ['https://cdn.hamropasal.test/p/tea.webp'],
        metadata: { brand: 'Ilam' },
      });
      expect(body.products[1]).toMatchObject({
        in_stock: false,
        stock_quantity: 0,
        category_id: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('is_active');
    });

    it('filters by vendor', async () => {
      const first = await createVendor(db);
      const second = await createVendor(db);
      const mine = await createProduct(db, first, 1);
      await createProduct(db, second, 1);

      expect(idsOf(await products({ vendor_id: first }))).toEqual([mine]);
      // A vendor that is not LIVE, or does not exist, simply has nothing to show.
      const sandboxed = await createVendor(db, { status: 'SANDBOXED' });
      await createProduct(db, sandboxed, 1);
      expect(idsOf(await products({ vendor_id: sandboxed }))).toEqual([]);
      expect(idsOf(await products({ vendor_id: randomUUID() }))).toEqual([]);
    });

    describe('category_id (the hierarchy)', () => {
      it('matches the category and all of its active descendants', async () => {
        const vendorId = await createVendor(db);
        const groceries = await createCategory(db, { name: 'Groceries' });
        const dairy = await createCategory(db, { name: 'Dairy', parentId: groceries });
        const milk = await createCategory(db, { name: 'Milk', parentId: dairy });
        const electronics = await createCategory(db, { name: 'Electronics' });
        const inRoot = await createProduct(db, vendorId, 1, 100, {
          name: '1 rice',
          category_id: groceries,
        });
        const inChild = await createProduct(db, vendorId, 1, 100, {
          name: '2 paneer',
          category_id: dairy,
        });
        const inGrandchild = await createProduct(db, vendorId, 1, 100, {
          name: '3 milk',
          category_id: milk,
        });
        await createProduct(db, vendorId, 1, 100, { name: '4 radio', category_id: electronics });
        await createProduct(db, vendorId, 1, 100, { name: '5 unmapped' });

        expect(idsOf(await products({ category_id: groceries }))).toEqual([
          inRoot,
          inChild,
          inGrandchild,
        ]);
        expect(idsOf(await products({ category_id: dairy }))).toEqual([inChild, inGrandchild]);
        expect(idsOf(await products({ category_id: milk }))).toEqual([inGrandchild]);
      });

      it('leaves out the products of a deactivated branch', async () => {
        const vendorId = await createVendor(db);
        const root = await createCategory(db);
        const shown = await createCategory(db, { parentId: root });
        const hidden = await createCategory(db, { parentId: root, isActive: false });
        const underHidden = await createCategory(db, { parentId: hidden });
        const visible = await createProduct(db, vendorId, 1, 100, { category_id: shown });
        await createProduct(db, vendorId, 1, 100, { category_id: hidden });
        await createProduct(db, vendorId, 1, 100, { category_id: underHidden });

        expect(idsOf(await products({ category_id: root }))).toEqual([visible]);
      });

      it('answers 404 for an unknown or deactivated category', async () => {
        const inactive = await createCategory(db, { isActive: false });

        for (const res of [
          await getProducts({ category_id: randomUUID() }),
          await getProducts({ category_id: inactive }),
        ]) {
          expect(res.status).toBe(404);
          expect(errorOf(res).code).toBe('CATEGORY_NOT_FOUND');
        }
      });

      it('combines with the vendor and search filters', async () => {
        const word = marker();
        const first = await createVendor(db);
        const second = await createVendor(db);
        const categoryId = await createCategory(db);
        const wanted = await createProduct(db, first, 1, 100, {
          name: `${word} honey`,
          category_id: categoryId,
        });
        await createProduct(db, first, 1, 100, { name: `${word} honey plain` });
        await createProduct(db, second, 1, 100, { name: `${word} honey`, category_id: categoryId });
        await createProduct(db, first, 1, 100, { name: `${word} ghee`, category_id: categoryId });

        const body = await products({
          category_id: categoryId,
          vendor_id: first,
          search: `${word} honey`,
        });

        expect(idsOf(body)).toEqual([wanted]);
      });
    });

    describe('search (full text)', () => {
      it('matches word prefixes in the name or the description, case-insensitively', async () => {
        const word = marker();
        const vendorId = await createVendor(db);
        const noodles = await createProduct(db, vendorId, 1, 100, {
          name: `Wai Wai Noodles ${word}`,
        });
        const rice = await createProduct(db, vendorId, 1, 100, {
          name: `Basmati Rice 5kg ${word}`,
          description: 'Long grain, goes well with noodles soup.',
        });
        const tea = await createProduct(db, vendorId, 1, 100, { name: `Ilam Tea ${word}` });
        const found = async (search: string) => idsOf(await products({ search }));

        // Every word must match; a word matches from its start.
        expect(await found(`${word} noodles`)).toEqual([rice, noodles]);
        expect(await found(`${word} NOOD`)).toEqual([rice, noodles]);
        expect(await found(`wai ${word}`)).toEqual([noodles]);
        expect(await found(`${word} basmati 5kg`)).toEqual([rice]);
        expect(await found(`${word} il`)).toEqual([tea]);
        // Not a substring search: "oodles" starts no word.
        expect(await found(`${word} oodles`)).toEqual([]);
        expect(await found(`${word} noodles tea`)).toEqual([]);
      });

      it('finds Nepali (Devanagari) product names', async () => {
        const word = marker();
        const vendorId = await createVendor(db);
        const dhau = await createProduct(db, vendorId, 1, 250, { name: `जुजु धौ ${word}` });
        await createProduct(db, vendorId, 1, 60, { name: `रायो को साग ${word}` });

        expect(idsOf(await products({ search: `${word} धौ` }))).toEqual([dhau]);
        expect(idsOf(await products({ search: `जुजु ${word}` }))).toEqual([dhau]);
      });

      it('treats punctuation and tsquery operators as separators, never as syntax', async () => {
        const word = marker();
        const vendorId = await createVendor(db);
        const honey = await createProduct(db, vendorId, 1, 900, { name: `Local Honey ${word}` });

        const injected = await getProducts({ search: `${word}' | !honey & (` });
        const onlySymbols = await getProducts({ search: "'&|!():*<->" });

        expect(injected.status).toBe(200);
        expect(idsOf(bodyOf(productListResponseSchema, injected))).toEqual([honey]);
        expect(onlySymbols.status).toBe(200);
        expect(bodyOf(productListResponseSchema, onlySymbols)).toEqual({
          products: [],
          next_cursor: null,
        });
      });

      it('is served by the GIN index products_search_idx', async () => {
        const plan = await db.transaction(async (tx) => {
          // Forbid the sequential scan so the planner must show whether the index is usable.
          await tx.execute(sql`SET LOCAL enable_seqscan = off`);
          const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(sql`
            EXPLAIN SELECT id FROM products
             WHERE to_tsvector('simple', "name" || ' ' || coalesce("description", ''))
                   @@ to_tsquery('simple', 'noodles:*')`);
          return rows.map((row) => row['QUERY PLAN']).join('\n');
        });

        expect(plan).toContain('products_search_idx');
      });
    });

    describe('pagination', () => {
      it('walks every page in name order without gaps or repeats', async () => {
        const word = marker();
        const vendorId = await createVendor(db);
        const expected: string[] = [];
        for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
          expected.push(await createProduct(db, vendorId, 1, 100, { name: `${word} ${name}` }));
        }

        const pages: string[][] = [];
        let cursor: string | undefined;
        for (let n = 0; n < 10; n++) {
          const body = await products({
            search: word,
            limit: '3',
            ...(cursor === undefined ? {} : { cursor }),
          });
          pages.push(idsOf(body));
          if (body.next_cursor === null) break;
          cursor = body.next_cursor;
        }

        expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);
        expect(pages.flat()).toEqual(expected);
      });

      it('has no next page when the last page is exactly full', async () => {
        const vendorId = await createVendor(db);
        await createProduct(db, vendorId, 1);
        await createProduct(db, vendorId, 1);

        const body = await products({ vendor_id: vendorId, limit: '2' });

        expect(body.products).toHaveLength(2);
        expect(body.next_cursor).toBeNull();
      });

      it('returns at most 20 products by default', async () => {
        const vendorId = await createVendor(db);
        for (let n = 0; n < 21; n++) await createProduct(db, vendorId, 1);

        const body = await products({ vendor_id: vendorId });

        expect(body.products).toHaveLength(20);
        expect(body.next_cursor).toBe(body.products[19]?.id);
      });

      it('refuses an unknown cursor and malformed parameters', async () => {
        const unknown = await getProducts({ cursor: randomUUID() });
        const bad = await Promise.all([
          getProducts({ limit: '0' }),
          getProducts({ limit: '51' }),
          getProducts({ limit: 'ten' }),
          getProducts({ cursor: 'nope' }),
          getProducts({ category_id: 'nope' }),
          getProducts({ search: '   ' }),
          getProducts({ search: 'x'.repeat(101) }),
          getProducts({ categoryId: randomUUID() }),
        ]);

        expect(unknown.status).toBe(400);
        expect(errorOf(unknown).code).toBe('INVALID_CURSOR');
        for (const res of bad) {
          expect(res.status).toBe(400);
          expect(errorOf(res).code).toBe('VALIDATION_FAILED');
        }
      });
    });
  });
});

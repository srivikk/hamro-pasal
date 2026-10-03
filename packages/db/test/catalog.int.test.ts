import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { createTestPool, createVendor, firstRow, pgError } from './support/fixtures';

/** Phase 17 (migration 0016): what the database itself guarantees about categories and products. */
describe('catalog schema guards', () => {
  let pool: Pool;
  let vendorId: string;

  beforeAll(async () => {
    pool = createTestPool();
    vendorId = await createVendor(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  const slug = () => `cat-${randomUUID()}`;

  async function insertCategory(
    values: { name?: string; slug?: string; parentId?: string | null; displayOrder?: number } = {},
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO categories (name, slug, parent_id, display_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        values.name ?? 'Category',
        values.slug ?? slug(),
        values.parentId ?? null,
        values.displayOrder ?? 0,
      ],
    );
    return firstRow(rows).id;
  }

  function insertProduct(columns: Record<string, unknown> = {}) {
    const values: Record<string, unknown> = {
      vendor_id: vendorId,
      name: `Product ${randomUUID()}`,
      price_npr: 100,
      ...columns,
    };
    const names = Object.keys(values);
    return pool.query<{ id: string }>(
      `INSERT INTO products (${names.join(', ')})
       VALUES (${names.map((_, n) => `$${String(n + 1)}`).join(', ')}) RETURNING id`,
      Object.values(values),
    );
  }

  describe('categories', () => {
    it('requires a unique slug of lower-case words joined by hyphens', async () => {
      const taken = slug();
      await insertCategory({ slug: taken });

      const duplicate = await pgError(insertCategory({ slug: taken }));
      expect(duplicate.code).toBe('23505');
      expect(duplicate.constraint).toBe('categories_slug_key');

      for (const bad of ['Dairy', 'dairy products', 'dairy--eggs', '-dairy', 'dairy-', '']) {
        const error = await pgError(insertCategory({ slug: bad }));
        expect(error.constraint).toBe('categories_slug_check');
      }
    });

    it('refuses a blank name and a negative display order', async () => {
      expect((await pgError(insertCategory({ name: '   ' }))).constraint).toBe(
        'categories_name_check',
      );
      expect((await pgError(insertCategory({ displayOrder: -1 }))).constraint).toBe(
        'categories_display_order_check',
      );
    });

    it('refuses an unknown parent and a category that is its own parent', async () => {
      const unknown = await pgError(insertCategory({ parentId: randomUUID() }));
      expect(unknown.code).toBe('23503');
      expect(unknown.constraint).toBe('categories_parent_id_categories_id_fk');

      const id = await insertCategory();
      const own = await pgError(
        pool.query('UPDATE categories SET parent_id = id WHERE id = $1', [id]),
      );
      expect(own.constraint).toBe('categories_not_own_parent_check');
    });

    it('cannot be deleted while it has a subcategory or a product', async () => {
      const parent = await insertCategory();
      const child = await insertCategory({ parentId: parent });
      await insertProduct({ category_id: child });

      const withChild = await pgError(pool.query('DELETE FROM categories WHERE id = $1', [parent]));
      const withProduct = await pgError(
        pool.query('DELETE FROM categories WHERE id = $1', [child]),
      );

      expect(withChild.code).toBe('23503');
      expect(withChild.constraint).toBe('categories_parent_id_categories_id_fk');
      expect(withProduct.code).toBe('23503');
      expect(withProduct.constraint).toBe('products_category_id_categories_id_fk');
    });

    it('bumps updated_at on update', async () => {
      const id = await insertCategory();
      const before = firstRow(
        (
          await pool.query<{ updated_at: Date }>(
            'SELECT updated_at FROM categories WHERE id = $1',
            [id],
          )
        ).rows,
      );

      const after = firstRow(
        (
          await pool.query<{ updated_at: Date }>(
            `UPDATE categories SET name = 'Renamed' WHERE id = $1 RETURNING updated_at`,
            [id],
          )
        ).rows,
      );

      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });
  });

  describe('products', () => {
    it('refuses an unknown category', async () => {
      const error = await pgError(insertProduct({ category_id: randomUUID() }));

      expect(error.code).toBe('23503');
      expect(error.constraint).toBe('products_category_id_categories_id_fk');
    });

    it.each([
      ['a negative stock', { stock_quantity: -1 }, 'products_stock_quantity_check'],
      ['a blank unit', { unit: '  ' }, 'products_unit_check'],
      ['a blank description', { description: ' ' }, 'products_description_check'],
      ['a zero price', { price_npr: 0 }, 'products_price_check'],
      [
        'more than 8 images',
        { image_urls: Array.from({ length: 9 }, (_, n) => `https://cdn.test/${String(n)}.webp`) },
        'products_image_urls_check',
      ],
      ['metadata that is not an object', { metadata: '["tea"]' }, 'products_metadata_check'],
    ])('refuses %s', async (_label, columns, constraint) => {
      const error = await pgError(insertProduct(columns));

      expect(error.code).toBe('23514');
      expect(error.constraint).toBe(constraint);
    });

    it('never lets stock be decremented below zero', async () => {
      const id = firstRow((await insertProduct({ stock_quantity: 2 })).rows).id;

      const error = await pgError(
        pool.query('UPDATE products SET stock_quantity = stock_quantity - 3 WHERE id = $1', [id]),
      );

      expect(error.constraint).toBe('products_stock_quantity_check');
    });

    it('has the listing indexes and the full-text GIN index', async () => {
      const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'products'`,
      );
      const definitions = new Map(rows.map((row) => [row.indexname, row.indexdef]));

      expect(definitions.get('products_vendor_id_is_active_idx')).toContain(
        '(vendor_id, is_active)',
      );
      expect(definitions.get('products_category_id_is_active_idx')).toContain(
        '(category_id, is_active)',
      );
      expect(definitions.get('products_search_idx')).toContain('USING gin');
      expect(definitions.get('products_search_idx')).toContain("to_tsvector('simple'");
      // Replaced by the (vendor_id, is_active) index, which serves the same lookups.
      expect(definitions.has('products_vendor_id_idx')).toBe(false);
    });
  });
});

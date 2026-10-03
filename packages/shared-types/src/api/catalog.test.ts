import { randomUUID } from 'node:crypto';

import { categorySchema, productSchema } from '../domain/entities';
import {
  adminCategoryWriteRequestSchema,
  adminProductViewSchema,
  buildCategoryTree,
  flattenCategoryTree,
  MAX_PRODUCT_METADATA_BYTES,
  productListQuerySchema,
  publicProductSchema,
  slugifyCategoryName,
  vendorProductCreateRequestSchema,
  vendorProductStockRequestSchema,
} from './catalog';

const item = (id: string, parentId: string | null, order: number, name = id) => ({
  id,
  parent_id: parentId,
  display_order: order,
  name,
});

describe('buildCategoryTree', () => {
  it('nests children under their parent, siblings by display_order then name', () => {
    const tree = buildCategoryTree([
      item('snacks', 'groceries', 2),
      item('electronics', null, 2),
      item('rice', 'staples', 0),
      item('groceries', null, 1),
      item('staples', 'groceries', 1, 'Staples'),
      item('dairy', 'groceries', 1, 'Dairy'),
    ]);

    expect(tree.map((node) => node.id)).toEqual(['groceries', 'electronics']);
    expect(tree[0]?.children.map((node) => node.id)).toEqual(['dairy', 'staples', 'snacks']);
    expect(tree[0]?.depth).toBe(1);
    expect(tree[0]?.children[1]?.children).toEqual([
      expect.objectContaining({ id: 'rice', depth: 3, children: [] }),
    ]);
  });

  it('flattens depth-first: each parent directly before its descendants', () => {
    const flat = flattenCategoryTree(
      buildCategoryTree([
        item('b', null, 1),
        item('a', null, 0),
        item('a2', 'a', 1),
        item('a1', 'a', 0),
        item('a1x', 'a1', 0),
      ]),
    );

    expect(flat.map((node) => `${node.id}@${String(node.depth)}`)).toEqual([
      'a@1',
      'a1@2',
      'a1x@3',
      'a2@2',
      'b@1',
    ]);
  });

  it('drops a branch whose parent is missing (a hidden ancestor hides its subtree)', () => {
    const tree = buildCategoryTree([
      item('root', null, 0),
      item('orphan', 'hidden-parent', 0),
      item('orphan-child', 'orphan', 0),
    ]);

    expect(flattenCategoryTree(tree).map((node) => node.id)).toEqual(['root']);
  });

  it('never loops on a cycle in the input', () => {
    expect(buildCategoryTree([item('a', 'b', 0), item('b', 'a', 0)])).toEqual([]);
  });
});

describe('slugifyCategoryName', () => {
  it('lower-cases, strips accents and joins words with single hyphens', () => {
    expect(slugifyCategoryName('  Dairy & Eggs  ')).toBe('dairy-eggs');
    expect(slugifyCategoryName('Café / Bakery 24x7')).toBe('cafe-bakery-24x7');
  });

  it('is empty for a name without ASCII letters or digits', () => {
    expect(slugifyCategoryName('तरकारी')).toBe('');
  });

  it('never ends in a hyphen after truncation', () => {
    const slug = slugifyCategoryName(`${'a'.repeat(79)} b c`);
    expect(slug).toBe('a'.repeat(79));
  });
});

describe('adminCategoryWriteRequestSchema', () => {
  it('defaults to an active root category at position 0', () => {
    expect(
      adminCategoryWriteRequestSchema.parse({ name: ' Groceries ', slug: 'groceries' }),
    ).toEqual({
      name: 'Groceries',
      slug: 'groceries',
      parent_id: null,
      icon_url: null,
      display_order: 0,
      is_active: true,
    });
  });

  it.each(['Groceries', 'dairy--eggs', '-dairy', 'dairy-', 'dairy eggs', 'तरकारी', ''])(
    'refuses the slug %p',
    (slug) => {
      expect(adminCategoryWriteRequestSchema.safeParse({ name: 'X', slug }).success).toBe(false);
    },
  );

  it('refuses a blank name, a non-http icon, a negative order and unknown fields', () => {
    const base = { name: 'Dairy', slug: 'dairy' };
    const parse = (extra: Record<string, unknown>) =>
      adminCategoryWriteRequestSchema.safeParse({ ...base, ...extra }).success;

    expect(parse({ name: '   ' })).toBe(false);
    expect(parse({ icon_url: 'javascript:alert(1)' })).toBe(false);
    expect(parse({ icon_url: 'https://cdn.hamropasal.test/icons/dairy.webp' })).toBe(true);
    expect(parse({ display_order: -1 })).toBe(false);
    expect(parse({ display_order: 1.5 })).toBe(false);
    expect(parse({ parent_id: 'not-a-uuid' })).toBe(false);
    expect(parse({ id: randomUUID() })).toBe(false);
  });
});

describe('vendorProductCreateRequestSchema', () => {
  const categoryId = randomUUID();
  const base = { category_id: categoryId, name: 'Ilam Tea 500g', price_npr: 450 };
  const parse = (extra: Record<string, unknown>) =>
    vendorProductCreateRequestSchema.safeParse({ ...base, ...extra });

  it('fills the defaults: one piece, no stock, active, no images or metadata', () => {
    expect(vendorProductCreateRequestSchema.parse(base)).toEqual({
      category_id: categoryId,
      name: 'Ilam Tea 500g',
      description: null,
      price_npr: 450,
      unit: 'piece',
      stock_quantity: 0,
      image_urls: [],
      is_active: true,
      metadata: {},
    });
  });

  it('trims the text fields and stores a blank description as null', () => {
    const parsed = vendorProductCreateRequestSchema.parse({
      ...base,
      name: '  Ilam Tea 500g ',
      description: '   ',
      unit: ' kg ',
    });

    expect(parsed).toMatchObject({ name: 'Ilam Tea 500g', description: null, unit: 'kg' });
  });

  it('requires a category and a price in whole paisa above zero', () => {
    expect(vendorProductCreateRequestSchema.safeParse({ name: 'Tea', price_npr: 1 }).success).toBe(
      false,
    );
    expect(parse({ price_npr: 0 }).success).toBe(false);
    expect(parse({ price_npr: -5 }).success).toBe(false);
    expect(parse({ price_npr: 10.005 }).success).toBe(false);
    expect(parse({ price_npr: 10.05 }).success).toBe(true);
    expect(parse({ price_npr: 1_000_001 }).success).toBe(false);
  });

  it('refuses negative or fractional stock, too many images and non-http image URLs', () => {
    expect(parse({ stock_quantity: -1 }).success).toBe(false);
    expect(parse({ stock_quantity: 2.5 }).success).toBe(false);
    expect(parse({ image_urls: ['file:///etc/passwd'] }).success).toBe(false);
    expect(
      parse({
        image_urls: Array.from(
          { length: 9 },
          (_, n) => `https://cdn.hamropasal.test/p/${String(n)}.webp`,
        ),
      }).success,
    ).toBe(false);
  });

  it('accepts a JSON object as metadata and refuses an oversized or non-object one', () => {
    expect(parse({ metadata: { brand: 'Ilam', weight_g: 500, tags: ['tea'] } }).success).toBe(true);
    expect(parse({ metadata: ['tea'] }).success).toBe(false);
    expect(parse({ metadata: { note: 'x'.repeat(MAX_PRODUCT_METADATA_BYTES) } }).success).toBe(
      false,
    );
  });
});

describe('vendorProductStockRequestSchema', () => {
  it('takes a whole quantity of zero or more, and nothing else', () => {
    expect(vendorProductStockRequestSchema.parse({ stock_quantity: 0 })).toEqual({
      stock_quantity: 0,
    });
    expect(vendorProductStockRequestSchema.safeParse({ stock_quantity: -1 }).success).toBe(false);
    expect(vendorProductStockRequestSchema.safeParse({ stock_quantity: 1.5 }).success).toBe(false);
    expect(vendorProductStockRequestSchema.safeParse({ stock_quantity: '5' }).success).toBe(false);
    expect(
      vendorProductStockRequestSchema.safeParse({ stock_quantity: 5, price_npr: 1 }).success,
    ).toBe(false);
  });
});

describe('productListQuerySchema', () => {
  it('reads the filters and the page from query strings', () => {
    const categoryId = randomUUID();
    const vendorId = randomUUID();
    const cursor = randomUUID();

    expect(
      productListQuerySchema.parse({
        category_id: categoryId,
        vendor_id: vendorId,
        search: '  wai wai ',
        limit: '10',
        cursor,
      }),
    ).toEqual({
      category_id: categoryId,
      vendor_id: vendorId,
      search: 'wai wai',
      limit: 10,
      cursor,
    });
    expect(productListQuerySchema.parse({})).toEqual({});
  });

  it('refuses a blank search, a limit out of range and unknown filters', () => {
    expect(productListQuerySchema.safeParse({ search: '   ' }).success).toBe(false);
    expect(productListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(productListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(productListQuerySchema.safeParse({ categoryId: randomUUID() }).success).toBe(false);
  });
});

describe('product views', () => {
  const view = {
    id: randomUUID(),
    category_id: randomUUID(),
    name: 'Ilam Tea 500g',
    description: null,
    price_npr: 450,
    unit: 'pack',
    image_urls: [],
    metadata: { brand: 'Ilam' },
  };

  it('the public product carries the on-hand stock, but no vendor-only fields', () => {
    const product = {
      ...view,
      vendor: { id: randomUUID(), business_name: 'Thamel Kirana Pasal' },
      in_stock: true,
      stock_quantity: 60,
    };

    expect(publicProductSchema.parse(product)).toEqual(product);
    expect(publicProductSchema.safeParse({ ...product, stock_quantity: -1 }).success).toBe(false);
    expect(publicProductSchema.safeParse({ ...product, stock_quantity: 1.5 }).success).toBe(false);
    expect(publicProductSchema.safeParse({ ...view, in_stock: true }).success).toBe(false);
    expect(publicProductSchema.safeParse({ ...product, is_active: true }).success).toBe(false);
  });

  it('the admin product names its vendor, standing and category', () => {
    const product = {
      ...view,
      stock_quantity: 60,
      is_active: false,
      created_at: '2026-10-03T06:00:00.000Z',
      updated_at: '2026-10-03T06:00:00.000Z',
      vendor: { id: randomUUID(), business_name: 'Thamel Kirana Pasal', status: 'SUSPENDED' },
      category_name: null,
    };

    expect(adminProductViewSchema.parse(product)).toEqual(product);
  });
});

describe('catalog entities', () => {
  it('a category row needs a slug in the stored format', () => {
    const row = {
      id: randomUUID(),
      name: 'Dairy',
      slug: 'dairy',
      parent_id: null,
      icon_url: null,
      display_order: 0,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(categorySchema.parse(row)).toEqual(row);
    expect(categorySchema.safeParse({ ...row, slug: 'Dairy Products' }).success).toBe(false);
  });

  it('a product row may predate the taxonomy (no category)', () => {
    const row = {
      id: randomUUID(),
      vendor_id: randomUUID(),
      category_id: null,
      name: 'Ilam Tea 500g',
      description: null,
      price_npr: 450,
      unit: 'piece',
      stock_quantity: 60,
      image_urls: [],
      is_active: true,
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };

    expect(productSchema.parse(row)).toEqual(row);
    expect(productSchema.safeParse({ ...row, stock_quantity: -1 }).success).toBe(false);
  });
});

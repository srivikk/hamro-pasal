import type {
  AdminCategoryView,
  AdminProductListResponseBody,
  AdminProductView,
} from '@hamro-pasal/shared-types';

import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { createSessionStore } from '../auth/session-store';
import { tabFromHash } from '../tabs';
import {
  canHaveChildren,
  categoryErrorMessage,
  categoryRows,
  categoryVisibility,
  deleteBlockedReason,
  emptyCategoryForm,
  formFromCategory,
  hiddenCounts,
  parentOptions,
  validateCategoryForm,
  visibilityBadge,
  withName,
} from './categories/category-rules';
import {
  activeToggle,
  productVisibility,
  replaceProduct,
  stockLabel,
  toggleErrorMessage,
} from './products/product-rules';

const ID = {
  groceries: '11111111-1111-4111-8111-111111111111',
  dairy: '22222222-2222-4222-8222-222222222222',
  milk: '33333333-3333-4333-8333-333333333333',
  snacks: '44444444-4444-4444-8444-444444444444',
  electronics: '55555555-5555-4555-8555-555555555555',
  product: '66666666-6666-4666-8666-666666666666',
  vendor: '77777777-7777-4777-8777-777777777777',
} as const;

function category(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<AdminCategoryView> = {},
): AdminCategoryView {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    parent_id: parentId,
    icon_url: null,
    display_order: 0,
    is_active: true,
    product_count: 0,
    created_at: '2026-10-03T06:00:00.000Z',
    updated_at: '2026-10-03T06:00:00.000Z',
    ...extra,
  };
}

/*
 * Groceries ─ Dairy ─ Milk (3 products)
 *           └ Snacks
 * Electronics
 */
const TAXONOMY: readonly AdminCategoryView[] = [
  category(ID.snacks, 'Snacks', ID.groceries, { display_order: 2 }),
  category(ID.electronics, 'Electronics', null, { display_order: 2 }),
  category(ID.milk, 'Milk', ID.dairy, { product_count: 3 }),
  category(ID.groceries, 'Groceries', null, { display_order: 1 }),
  category(ID.dairy, 'Dairy', ID.groceries, { display_order: 1, is_active: false }),
];

const product: AdminProductView = {
  id: ID.product,
  category_id: ID.milk,
  name: 'Ilam Tea 500g',
  description: null,
  price_npr: 450,
  unit: 'pack',
  stock_quantity: 1200,
  image_urls: [],
  is_active: true,
  metadata: {},
  created_at: '2026-10-03T06:00:00.000Z',
  updated_at: '2026-10-03T06:00:00.000Z',
  vendor: { id: ID.vendor, business_name: 'Thamel Kirana Pasal', status: 'LIVE' },
  category_name: 'Milk',
};

describe('tabs', () => {
  it('reads the tab from the URL hash and falls back to the first one', () => {
    expect(tabFromHash('#/categories')).toBe('categories');
    expect(tabFromHash('#/products')).toBe('products');
    expect(tabFromHash('#/vendors')).toBe('vendors');
    expect(tabFromHash('')).toBe('dlq');
    expect(tabFromHash('#/nowhere')).toBe('dlq');
  });
});

describe('category tree rows', () => {
  const rows = categoryRows(TAXONOMY);

  it('lists parents before their children, siblings by display order, with depths', () => {
    expect(rows.map((row) => `${row.name}@${String(row.depth)}`)).toEqual([
      'Groceries@1',
      'Dairy@2',
      'Milk@3',
      'Snacks@2',
      'Electronics@1',
    ]);
  });

  it('offers "Add subcategory" down to the second level only', () => {
    const offered = rows.filter(canHaveChildren).map((row) => row.name);

    expect(offered).toEqual(['Groceries', 'Dairy', 'Snacks', 'Electronics']);
  });

  it('blocks Delete while a category has subcategories or products, and says why', () => {
    const reason = (name: string) => {
      const row = rows.find((r) => r.name === name);
      if (row === undefined) throw new Error(name);
      return deleteBlockedReason(row);
    };

    expect(reason('Groceries')).toMatch(/subcategories/);
    expect(reason('Dairy')).toMatch(/subcategories/);
    expect(reason('Milk')).toBe('3 products are mapped here: hide the category instead.');
    expect(reason('Snacks')).toBeNull();
    expect(reason('Electronics')).toBeNull();
  });
});

describe('parentOptions', () => {
  const rows = categoryRows(TAXONOMY);
  const names = (editingId: string | null) =>
    parentOptions(rows, editingId).map((option) => option.label);

  it('lets a new category go under any first or second level, indented by depth', () => {
    expect(names(null)).toEqual(['Groceries', '— Dairy', '— Snacks', 'Electronics']);
  });

  it('never offers the category itself or its own subcategories', () => {
    // Groceries is three levels tall: it fits nowhere but the top level.
    expect(names(ID.groceries)).toEqual([]);
  });

  it('counts the moved subtree against the depth limit', () => {
    // Dairy carries Milk: only a first level can take it.
    expect(names(ID.dairy)).toEqual(['Groceries', 'Electronics']);
    // A leaf fits under first and second levels, but not under itself.
    expect(names(ID.milk)).toEqual(['Groceries', '— Dairy', '— Snacks', 'Electronics']);
    expect(names(ID.snacks)).toEqual(['Groceries', '— Dairy', 'Electronics']);
  });
});

describe('category form', () => {
  it('starts a new category active, at position 0, under the chosen parent', () => {
    expect(emptyCategoryForm()).toEqual({
      name: '',
      slug: '',
      parentId: '',
      iconUrl: '',
      displayOrder: '0',
      isActive: true,
    });
    expect(emptyCategoryForm(ID.groceries).parentId).toBe(ID.groceries);
  });

  it('loads an existing category into the fields', () => {
    const form = formFromCategory(
      category(ID.milk, 'Milk', ID.dairy, {
        icon_url: 'https://cdn.hamropasal.test/icons/milk.webp',
        display_order: 4,
        is_active: false,
      }),
    );

    expect(form).toEqual({
      name: 'Milk',
      slug: 'milk',
      parentId: ID.dairy,
      iconUrl: 'https://cdn.hamropasal.test/icons/milk.webp',
      displayOrder: '4',
      isActive: false,
    });
  });

  it('fills the slug from the name until the slug is edited by hand', () => {
    let form = withName(emptyCategoryForm(), 'Dairy');
    form = withName(form, 'Dairy & Eggs');
    expect(form.slug).toBe('dairy-eggs');

    form = withName({ ...form, slug: 'milk-products' }, 'Dairy, Eggs & Cheese');
    expect(form).toMatchObject({ name: 'Dairy, Eggs & Cheese', slug: 'milk-products' });
  });

  it('leaves the slug of an existing category alone when it is renamed', () => {
    const form = withName(
      formFromCategory(category(ID.dairy, 'Dairy', null, { slug: 'dairy-and-eggs' })),
      'Milk Products',
    );

    expect(form.slug).toBe('dairy-and-eggs');
  });

  it('turns valid fields into the request the API expects', () => {
    const result = validateCategoryForm({
      name: '  Dairy & Eggs ',
      slug: 'dairy-eggs',
      parentId: ID.groceries,
      iconUrl: ' https://cdn.hamropasal.test/icons/dairy.webp ',
      displayOrder: ' 3 ',
      isActive: false,
    });

    expect(result).toEqual({
      ok: true,
      request: {
        name: 'Dairy & Eggs',
        slug: 'dairy-eggs',
        parent_id: ID.groceries,
        icon_url: 'https://cdn.hamropasal.test/icons/dairy.webp',
        display_order: 3,
        is_active: false,
      },
    });
  });

  it('sends null for "top level" and for an empty icon', () => {
    const result = validateCategoryForm({ ...emptyCategoryForm(), name: 'Dairy', slug: 'dairy' });

    expect(result).toMatchObject({ ok: true, request: { parent_id: null, icon_url: null } });
  });

  it('names every field that is wrong', () => {
    const result = validateCategoryForm({
      name: '   ',
      slug: 'Dairy Products',
      parentId: '',
      iconUrl: 'cdn/icons/dairy.webp',
      displayOrder: '1.5',
      isActive: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['displayOrder', 'iconUrl', 'name', 'slug']);
    expect(result.errors.slug).toMatch(/lower-case/);
  });

  it.each(['', '-1', 'ten', '1e3'])('refuses the display order %p', (displayOrder) => {
    const result = validateCategoryForm({
      ...emptyCategoryForm(),
      name: 'Dairy',
      slug: 'dairy',
      displayOrder,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: { displayOrder: expect.any(String) as unknown },
    });
  });

  it('explains each server refusal', () => {
    const message = (code: string) => categoryErrorMessage(new ApiError(409, code, 'x'));

    expect(message('CATEGORY_SLUG_TAKEN')).toMatch(/slug/);
    expect(message('CATEGORY_CYCLE')).toMatch(/under itself/);
    expect(message('CATEGORY_TOO_DEEP')).toMatch(/3 levels/);
    expect(message('CATEGORY_IN_USE')).toMatch(/Hide it instead/);
    expect(message('CATEGORY_NOT_FOUND')).toMatch(/no longer exists/);
    expect(message('NETWORK_ERROR')).toMatch(/cannot be reached/);
    expect(categoryErrorMessage(new Error('boom'))).toBe(
      'The change could not be saved. Try again.',
    );
  });
});

describe('product rules', () => {
  it('says whether customers can see a product, and what hides it', () => {
    expect(productVisibility(product)).toEqual({ visible: true, label: 'Visible' });
    expect(productVisibility({ ...product, is_active: false })).toEqual({
      visible: false,
      label: 'Hidden',
    });
    expect(
      productVisibility({ ...product, vendor: { ...product.vendor, status: 'SUSPENDED' } }),
    ).toEqual({ visible: false, label: 'Vendor is SUSPENDED' });
  });

  it('labels the stock with its unit, and zero as out of stock', () => {
    expect(stockLabel(product)).toBe('1,200 pack');
    expect(stockLabel({ ...product, stock_quantity: 0 })).toBe('Out of stock');
  });

  it('offers Hide for an active product and Show for a hidden one', () => {
    expect(activeToggle(product)).toEqual({ label: 'Hide', next: false });
    expect(activeToggle({ ...product, is_active: false })).toEqual({ label: 'Show', next: true });
  });

  it('replaces the toggled product in whichever loaded page holds it', () => {
    const other = { ...product, id: ID.milk, name: 'Other' };
    const pages: AdminProductListResponseBody[] = [
      { products: [other], next_cursor: other.id },
      { products: [product], next_cursor: null },
    ];
    const hidden = { ...product, is_active: false };

    expect(replaceProduct(pages, hidden)).toEqual([
      { products: [other], next_cursor: other.id },
      { products: [hidden], next_cursor: null },
    ]);
  });

  it('explains a failed toggle', () => {
    expect(toggleErrorMessage(new ApiError(404, 'PRODUCT_NOT_FOUND', 'x'))).toMatch(
      /no longer exists/,
    );
    expect(toggleErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toMatch(/cannot be reached/);
    expect(toggleErrorMessage(new Error('boom'))).toBe('The change could not be saved. Try again.');
  });
});

describe('createAdminApi (catalog endpoints)', () => {
  function setup() {
    const calls: { call: string; body: unknown }[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push({
        call: `${init.method ?? ''} ${url}`,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
      const dairy = category(ID.dairy, 'Dairy', null);
      const body = url.includes('/products/')
        ? { product }
        : url.includes('/products')
          ? { products: [product], next_cursor: null }
          : init.method === 'GET'
            ? { categories: [dairy] }
            : { category: dairy };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const session = createSessionStore();
    session.getState().setSession({
      phone: '+9779800000099',
      user: { id: ID.vendor, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'a',
    });
    return { calls, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
  }

  it('calls each endpoint with the right method, path and body', async () => {
    const { calls, api } = setup();
    const input = { name: 'Dairy', slug: 'dairy', parent_id: null };

    await api.listCategories();
    await api.createCategory(input);
    await api.updateCategory(ID.dairy, { ...input, is_active: false });
    await expect(api.deleteCategory(ID.dairy)).resolves.toBeUndefined();
    await api.listProducts({});
    await api.listProducts({ vendorId: ID.vendor, cursor: ID.product });
    await api.setProductActive(ID.product, false);

    expect(calls).toEqual([
      { call: 'GET /api/admin/categories', body: undefined },
      { call: 'POST /api/admin/categories', body: input },
      { call: `PUT /api/admin/categories/${ID.dairy}`, body: { ...input, is_active: false } },
      { call: `DELETE /api/admin/categories/${ID.dairy}`, body: undefined },
      { call: 'GET /api/admin/products', body: undefined },
      {
        call: `GET /api/admin/products?vendor_id=${ID.vendor}&cursor=${ID.product}`,
        body: undefined,
      },
      { call: `PATCH /api/admin/products/${ID.product}/active`, body: { is_active: false } },
    ]);
  });

  it("surfaces a refused delete as the server's error code", async () => {
    const session = createSessionStore();
    session.getState().setSession({
      phone: '+9779800000099',
      user: { id: ID.vendor, role: 'SUPER_ADMIN', first_name: null },
      accessToken: 'a',
    });
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'CATEGORY_IN_USE', message: 'in use' } }), {
          status: 409,
        }),
      );
    const api = createAdminApi(createApiClient({ baseUrl: '', fetch, session }));

    await expect(api.deleteCategory(ID.dairy)).rejects.toMatchObject({
      status: 409,
      code: 'CATEGORY_IN_USE',
    });
  });
});

describe('computed category visibility (decided 2026-10-20)', () => {
  const byId = new Map(TAXONOMY.map((row) => [row.id, row]));
  const of = (id: string) => {
    const row = byId.get(id);
    if (row === undefined) throw new Error('fixture');
    return categoryVisibility(row, byId);
  };

  it('shows an active category under active ancestors as Active, in green', () => {
    expect(of(ID.snacks)).toEqual({ kind: 'ACTIVE' });
    expect(visibilityBadge(of(ID.groceries))).toMatchObject({
      label: 'Active',
      className: 'status-replayed',
    });
  });

  it('shows a hidden category as Hidden, in red', () => {
    expect(visibilityBadge(of(ID.dairy))).toMatchObject({
      label: 'Hidden',
      className: 'status-pending',
    });
  });

  it('shows an active category under a hidden parent as Inactive (Parent Hidden), in amber', () => {
    // Milk is active itself; Dairy above it is hidden.
    expect(of(ID.milk)).toEqual({ kind: 'INHERITED_HIDDEN', hiddenAncestorName: 'Dairy' });
    expect(visibilityBadge(of(ID.milk))).toEqual({
      label: 'Inactive (Parent Hidden)',
      className: 'status-warn',
      title:
        'Active itself, but hidden because "Dairy" above it is hidden. Show that category to make this one visible again.',
    });
  });

  it('looks past any number of levels, naming the nearest hidden ancestor', () => {
    const deep = [
      category(ID.groceries, 'Groceries', null, { is_active: false }),
      category(ID.dairy, 'Dairy', ID.groceries),
      category(ID.milk, 'Milk', ID.dairy),
    ];
    const deepById = new Map(deep.map((row) => [row.id, row]));
    const milk = deepById.get(ID.milk);
    if (milk === undefined) throw new Error('fixture');
    expect(categoryVisibility(milk, deepById)).toEqual({
      kind: 'INHERITED_HIDDEN',
      hiddenAncestorName: 'Groceries',
    });
    expect(hiddenCounts(deep)).toEqual({ hidden: 1, inherited: 2 });
  });

  it('counts the hidden and the inherited apart', () => {
    expect(hiddenCounts(TAXONOMY)).toEqual({ hidden: 1, inherited: 1 });
  });
});

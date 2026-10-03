import type { AuthUser, CategoryView, VendorProductView } from '@hamro-pasal/shared-types';

import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { createSessionStore } from '../auth/session-store';
import { portalOf } from './auth/login-rules';
import {
  addedUrls,
  categoryLabel,
  categoryOptions,
  formFromProduct,
  parseStock,
  replaceOwnProduct,
  showRequest,
  uploadProblem,
  validateProductForm,
  vendorProductErrorMessage,
} from './vendor-portal/vendor-product-rules';

const ID = {
  groceries: '11111111-1111-4111-8111-111111111111',
  tea: '22222222-2222-4222-8222-222222222222',
  hidden: '33333333-3333-4333-8333-333333333333',
  product: '66666666-6666-4666-8666-666666666666',
  vendorUser: '77777777-7777-4777-8777-777777777777',
} as const;

const category = (id: string, name: string, parentId: string | null): CategoryView => ({
  id,
  name,
  slug: name.toLowerCase(),
  parent_id: parentId,
  icon_url: null,
  display_order: 0,
});

const TAXONOMY: readonly CategoryView[] = [
  category(ID.tea, 'Tea', ID.groceries),
  category(ID.groceries, 'Groceries', null),
];

const PHOTO = (n: number) =>
  `http://localhost:4000/uploads/product-images/${ID.product}/0000000${String(n)}-0000-4000-8000-000000000000.jpg`;

const product: VendorProductView = {
  id: ID.product,
  category_id: ID.tea,
  name: 'Ilam Tea 500g',
  description: 'Orthodox black tea.',
  price_npr: 450.5,
  unit: 'pack',
  stock_quantity: 12,
  image_urls: [PHOTO(1), PHOTO(2)],
  is_active: true,
  metadata: { brand: 'Ilam' },
  created_at: '2026-10-03T06:00:00.000Z',
  updated_at: '2026-10-03T06:00:00.000Z',
};

const VENDOR: AuthUser = { id: ID.vendorUser, role: 'VENDOR', first_name: 'Sita' };

describe('portalOf', () => {
  it('opens the dashboard for a Super Admin, the Vendor Portal for a vendor, nothing else', () => {
    const as = (role: AuthUser['role']) => portalOf({ ...VENDOR, role });

    expect(as('SUPER_ADMIN')).toBe('ADMIN');
    expect(as('VENDOR')).toBe('VENDOR');
    expect(as('CUSTOMER')).toBeNull();
    expect(as('DRIVER')).toBeNull();
  });
});

describe('product form', () => {
  it('starts from the product as it is', () => {
    expect(formFromProduct(product)).toEqual({
      name: 'Ilam Tea 500g',
      categoryId: ID.tea,
      description: 'Orthodox black tea.',
      price: '450.5',
      unit: 'pack',
      isActive: true,
      imageUrls: [PHOTO(1), PHOTO(2)],
    });
    expect(formFromProduct({ ...product, category_id: null, description: null })).toMatchObject({
      categoryId: '',
      description: '',
    });
  });

  it('builds the PUT body: metadata carried over, no stock, photos left to the server', () => {
    const result = validateProductForm(
      { ...formFromProduct(product), name: '  Ilam Gold ', price: '475', description: '  ' },
      product,
    );

    expect(result).toEqual({
      ok: true,
      request: {
        category_id: ID.tea,
        name: 'Ilam Gold',
        description: null,
        price_npr: 475,
        unit: 'pack',
        is_active: true,
        metadata: { brand: 'Ilam' },
      },
    });
  });

  it('sends the photo list only when the vendor removed one', () => {
    const form = formFromProduct(product);
    const removed = validateProductForm({ ...form, imageUrls: [PHOTO(2)] }, product);
    const cleared = validateProductForm({ ...form, imageUrls: [] }, product);

    expect(removed).toMatchObject({ ok: true, request: { image_urls: [PHOTO(2)] } });
    expect(cleared).toMatchObject({ ok: true, request: { image_urls: [] } });
  });

  it('names the fields the API would refuse', () => {
    const errorsFor = (values: Partial<ReturnType<typeof formFromProduct>>) => {
      const result = validateProductForm({ ...formFromProduct(product), ...values }, product);
      return result.ok ? [] : Object.keys(result.errors);
    };

    expect(errorsFor({ name: '   ' })).toEqual(['name']);
    expect(errorsFor({ categoryId: '' })).toEqual(['categoryId']);
    expect(errorsFor({ unit: '' })).toEqual(['unit']);
    for (const price of ['', '0', '-5', '10.005', '4,50', 'abc', '1e3', '1000001']) {
      expect(errorsFor({ price })).toEqual(['price']);
    }
    expect(errorsFor({ price: '0.5' })).toEqual([]);
    expect(errorsFor({ name: '', price: 'x' }).sort()).toEqual(['name', 'price']);
  });

  it('shows a hidden product again with everything else unchanged', () => {
    expect(showRequest({ ...product, is_active: false })).toEqual({
      category_id: ID.tea,
      name: 'Ilam Tea 500g',
      description: 'Orthodox black tea.',
      price_npr: 450.5,
      unit: 'pack',
      is_active: true,
      metadata: { brand: 'Ilam' },
    });
  });

  it('cannot show a product that has no category yet (it must be chosen in Edit)', () => {
    expect(showRequest({ ...product, is_active: false, category_id: null })).toBeNull();
  });
});

describe('parseStock', () => {
  it('accepts whole numbers from 0 to 1,000,000 and nothing else', () => {
    expect(parseStock('0')).toBe(0);
    expect(parseStock(' 42 ')).toBe(42);
    expect(parseStock('1000000')).toBe(1_000_000);
    for (const bad of ['', '-1', '2.5', '1e3', 'ten', '1000001', '१२']) {
      expect(parseStock(bad)).toBeNull();
    }
  });
});

describe('categories', () => {
  it('lists the taxonomy in tree order with subcategories indented', () => {
    expect(categoryOptions(TAXONOMY, ID.tea)).toEqual([
      { id: ID.groceries, label: 'Groceries' },
      { id: ID.tea, label: '— Tea' },
    ]);
  });

  it("keeps a product's hidden category selectable, marked as hidden", () => {
    expect(categoryOptions(TAXONOMY, ID.hidden)[0]).toEqual({
      id: ID.hidden,
      label: 'Current category (hidden by the admin)',
    });
    expect(categoryOptions(TAXONOMY, null)).toHaveLength(2);
  });

  it('labels a product with its category path', () => {
    expect(categoryLabel(TAXONOMY, ID.tea)).toBe('Groceries › Tea');
    expect(categoryLabel(TAXONOMY, ID.groceries)).toBe('Groceries');
    expect(categoryLabel(TAXONOMY, null)).toBe('No category');
    expect(categoryLabel(TAXONOMY, ID.hidden)).toBe('Hidden category');
  });
});

describe('uploadProblem', () => {
  const jpeg = (name = 'a.jpg', size = 1000) => ({ name, size, type: 'image/jpeg' });

  it('lets JPEG, PNG and WebP files of at most 5 MB through', () => {
    expect(
      uploadProblem(
        [
          jpeg('a.jpg', 5 * 1024 * 1024),
          { name: 'b.png', size: 10, type: 'image/png' },
          { name: 'c.webp', size: 10, type: 'image/webp' },
        ],
        5,
      ),
    ).toBeNull();
  });

  it('asks for a file, and refuses other types and larger files by name', () => {
    expect(uploadProblem([], 0)).toBe('Choose at least one photo.');
    expect(
      uploadProblem([jpeg(), { name: 'menu.pdf', size: 10, type: 'application/pdf' }], 0),
    ).toBe('menu.pdf is not a JPEG, PNG or WebP image.');
    expect(uploadProblem([{ name: 'anim.gif', size: 10, type: 'image/gif' }], 0)).toMatch(/anim/);
    expect(uploadProblem([jpeg('big.jpg', 5 * 1024 * 1024 + 1)], 0)).toBe(
      'big.jpg is larger than 5 MB.',
    );
  });

  it('counts against the 8 photos a product may have', () => {
    expect(uploadProblem([jpeg(), jpeg()], 6)).toBeNull();
    expect(uploadProblem([jpeg(), jpeg()], 7)).toBe(
      'Only 1 more photo fit (at most 8 per product).',
    );
    expect(uploadProblem([jpeg(), jpeg(), jpeg()], 6)).toMatch(/^Only 2 more photos fit/);
    expect(uploadProblem([jpeg()], 8)).toMatch(/at most 8 photos\. Remove one and save first/);
  });
});

describe('list helpers and messages', () => {
  it('replaces one product in the loaded pages', () => {
    const other = { ...product, id: ID.tea };
    const pages = [
      { products: [other], next_cursor: other.id },
      { products: [product], next_cursor: null },
    ];
    const updated = { ...product, stock_quantity: 0 };

    expect(replaceOwnProduct(pages, updated)).toEqual([
      { products: [other], next_cursor: other.id },
      { products: [updated], next_cursor: null },
    ]);
  });

  it('finds the URLs an upload added', () => {
    expect(addedUrls([PHOTO(1)], [PHOTO(1), PHOTO(2), PHOTO(3)])).toEqual([PHOTO(2), PHOTO(3)]);
    expect(addedUrls([PHOTO(1)], [PHOTO(1)])).toEqual([]);
  });

  it('explains the refusals a vendor can act on', () => {
    const message = (code: string) => vendorProductErrorMessage(new ApiError(400, code, 'x'));

    expect(message('PRODUCT_NAME_TAKEN')).toMatch(/already has a product with this name/);
    expect(message('CATEGORY_UNAVAILABLE')).toMatch(/Choose another/);
    expect(message('PRODUCT_IMAGE_LIMIT')).toMatch(/at most 8 photos/);
    expect(message('FILE_TOO_LARGE')).toMatch(/5 MB/);
    expect(message('UNSUPPORTED_MEDIA_TYPE')).toMatch(/JPEG, PNG or WebP/);
    expect(message('VENDOR_NOT_FOUND')).toMatch(/no shop/);
    expect(message('NETWORK_ERROR')).toMatch(/cannot be reached/);
    expect(vendorProductErrorMessage(new Error('boom'))).toBe(
      'The change could not be saved. Try again.',
    );
  });
});

interface Call {
  readonly call: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: unknown;
}

/** A fake API recording every call, with a vendor signed in (tokens in memory, no cookie). */
function setup(route?: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    const headers = new Headers(init.headers);
    const call: Call = {
      call: `${init.method ?? ''} ${url}`,
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
    };
    calls.push(call);
    if (route !== undefined) return Promise.resolve(route(call));
    if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }));
    const body = url.endsWith('/api/categories')
      ? { categories: TAXONOMY }
      : url.includes('/api/vendor/products/')
        ? { product }
        : { products: [product], next_cursor: null };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  const session = createSessionStore();
  session.getState().setSession({
    phone: '+9779800000011',
    user: VENDOR,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
  });
  return { calls, session, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
}

describe('createAdminApi (Vendor Portal endpoints)', () => {
  it('calls each endpoint with the right method, path and JSON body', async () => {
    const { calls, api } = setup();
    const request = { category_id: ID.tea, name: 'Ilam Gold', price_npr: 475 };

    await api.listOwnProducts({});
    await api.listOwnProducts({ cursor: ID.product });
    await api.updateOwnProduct(ID.product, request);
    await api.setOwnProductStock(ID.product, 30);
    await expect(api.hideOwnProduct(ID.product)).resolves.toBeUndefined();

    expect(calls.map(({ call, body }) => ({ call, body }))).toEqual([
      { call: 'GET /api/vendor/products', body: undefined },
      { call: `GET /api/vendor/products?cursor=${ID.product}`, body: undefined },
      { call: `PUT /api/vendor/products/${ID.product}`, body: request },
      { call: `PATCH /api/vendor/products/${ID.product}/stock`, body: { stock_quantity: 30 } },
      { call: `DELETE /api/vendor/products/${ID.product}`, body: undefined },
    ]);
    expect(calls.every((call) => call.authorization === 'Bearer access-1')).toBe(true);
    expect(calls[2]?.contentType).toBe('application/json');
  });

  it('reads the public taxonomy without a token', async () => {
    const { calls, api } = setup();

    await expect(api.listActiveCategories()).resolves.toEqual({ categories: TAXONOMY });
    expect(calls[0]).toMatchObject({ call: 'GET /api/categories', authorization: null });
  });

  it('uploads photos as FormData and leaves the Content-Type (the boundary) to the browser', async () => {
    const { calls, api } = setup();
    const first = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'front.jpg', {
      type: 'image/jpeg',
    });
    const second = new File([new Uint8Array([0x89, 0x50])], 'back.png', { type: 'image/png' });

    await api.uploadOwnProductImages(ID.product, [first, second]);

    const [call] = calls;
    expect(call?.call).toBe(`POST /api/vendor/products/${ID.product}/images`);
    expect(call?.authorization).toBe('Bearer access-1');
    // Not application/json, and not a hand-written multipart/form-data without a boundary.
    expect(call?.contentType).toBeNull();
    const form = call?.body;
    if (!(form instanceof FormData)) throw new Error('the body is not a FormData');
    expect([...form.keys()]).toEqual(['images', 'images']);
    const parts = form.getAll('images') as File[];
    expect(parts.map((part) => [part.name, part.type, part.size])).toEqual([
      ['front.jpg', 'image/jpeg', 3],
      ['back.png', 'image/png', 2],
    ]);
  });

  it('a real multipart request built from that body carries a boundary the server can parse', async () => {
    const { calls, api } = setup();
    await api.uploadOwnProductImages(ID.product, [
      new File([new Uint8Array([0xff, 0xd8, 0xff])], 'front.jpg', { type: 'image/jpeg' }),
    ]);

    // What fetch does with a FormData body when no Content-Type header was set.
    const sent = new Request('http://api.test/upload', {
      method: 'POST',
      body: calls[0]?.body as FormData,
    });
    const contentType = sent.headers.get('content-type') ?? '';
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)?.[1];

    expect(boundary).toBeDefined();
    const text = Buffer.from(await sent.arrayBuffer()).toString('latin1');
    expect(text.startsWith(`--${boundary ?? ''}\r\n`)).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="images"; filename="front.jpg"');
    expect(text).toContain('Content-Type: image/jpeg');
  });

  it("surfaces the server's refusal of an upload", async () => {
    const { api } = setup(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'PRODUCT_IMAGE_LIMIT',
              message: 'full',
              details: { max_images: 8, current_images: 8 },
            },
          }),
          { status: 422 },
        ),
    );

    await expect(
      api.uploadOwnProductImages(ID.product, [new File(['x'], 'a.jpg', { type: 'image/jpeg' })]),
    ).rejects.toMatchObject({ status: 422, code: 'PRODUCT_IMAGE_LIMIT' });
  });
});

describe('a vendor session (refresh token in memory, no cookie)', () => {
  const expired = () =>
    new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }), {
      status: 401,
    });
  const list = () => new Response(JSON.stringify({ products: [], next_cursor: null }));

  it('renews the access token with the body refresh token and replays the request', async () => {
    const { calls, session, api } = setup((call) => {
      if (call.call === 'POST /api/auth/token/refresh') {
        return new Response(
          JSON.stringify({
            token_type: 'Bearer',
            access_token: 'access-2',
            access_token_expires_in: 900,
          }),
        );
      }
      return call.authorization === 'Bearer access-2' ? list() : expired();
    });

    await expect(api.listOwnProducts({})).resolves.toEqual({ products: [], next_cursor: null });

    expect(calls.map(({ call, authorization, body }) => [call, authorization, body])).toEqual([
      ['GET /api/vendor/products', 'Bearer access-1', undefined],
      ['POST /api/auth/token/refresh', null, { refresh_token: 'refresh-1' }],
      ['GET /api/vendor/products', 'Bearer access-2', undefined],
    ]);
    expect(session.getState().session).toEqual({
      phone: '+9779800000011',
      user: VENDOR,
      accessToken: 'access-2',
      refreshToken: 'refresh-1',
    });
  });

  it('signs the vendor out when the refresh token is refused', async () => {
    const { session, api } = setup((call) =>
      call.call === 'POST /api/auth/token/refresh'
        ? new Response(
            JSON.stringify({ error: { code: 'REFRESH_TOKEN_INVALID', message: 'expired' } }),
            { status: 401 },
          )
        : expired(),
    );

    await expect(api.listOwnProducts({})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(session.getState().session).toBeNull();
  });

  it('never asks the cookie endpoint for a vendor', async () => {
    const { calls, api } = setup((call) =>
      call.call.includes('/api/auth/')
        ? new Response(JSON.stringify({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'x' } }), {
            status: 503,
          })
        : expired(),
    );

    await expect(api.listOwnProducts({})).rejects.toMatchObject({ status: 503 });
    expect(calls.map((call) => call.call)).not.toContain('POST /api/auth/refresh');
  });
});

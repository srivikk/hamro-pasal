import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { products, type Database } from '@hamro-pasal/db';
import {
  MAX_PRODUCT_IMAGE_BYTES,
  MAX_PRODUCT_IMAGES,
  productListResponseSchema,
  vendorMenuSchema,
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
  vendorUserIdOf,
  type VendorFixture,
} from './support/fixtures';
import {
  bearer,
  bodyOf,
  buildTestApp,
  errorOf,
  TEST_UPLOADS_BASE_URL,
  TEST_UPLOADS_DIR,
  type TestApp,
} from './support/http';
import { describeImage, paddedTo, photo } from './support/images';

const PNG_SIGNATURE = 'png';
let baseImages: Record<'jpeg' | 'png', Buffer>;
beforeAll(async () => {
  baseImages = { jpeg: await photo(), png: await photo({ format: 'png' }) };
});

/** A real image, padded after its end up to `size` bytes (a smaller size gives the image itself). */
function imageOfSize(size: number, kind: 'jpeg' | 'png' = 'jpeg'): Buffer {
  return paddedTo(baseImages[kind], size);
}

interface UploadFile {
  readonly bytes: Buffer;
  readonly name?: string;
  readonly type?: string;
  readonly field?: string;
}

/**
 * Phase 19: the vendor's product lifecycle (PUT, DELETE, POST …/images under
 * /api/vendor/products) on real Express + PostgreSQL + Redis, with photos on the local disk.
 */
describe('Vendor product lifecycle API', () => {
  let testApp: TestApp;
  let db: Database;
  let categoryId: string;

  beforeAll(async () => {
    testApp = buildTestApp();
    db = testApp.container.db;
    categoryId = await createCategory(db, { name: 'Lifecycle' });
  });

  afterAll(async () => {
    await testApp.container.close();
    await rm(TEST_UPLOADS_DIR, { recursive: true, force: true });
  });

  async function vendor(options: VendorFixture = {}) {
    const vendorId = await createVendor(db, options);
    return { vendorId, token: bearer(await vendorUserIdOf(db, vendorId), 'VENDOR') };
  }

  async function rowOf(productId: string) {
    const [row] = await db.select().from(products).where(eq(products.id, productId));
    if (row === undefined) throw new Error(`product ${productId} is gone`);
    return row;
  }

  const details = (extra: Record<string, unknown> = {}) => ({
    category_id: categoryId,
    name: `Ilam Tea ${randomUUID()}`,
    price_npr: 450,
    ...extra,
  });

  function put(token: string, productId: string, body: Record<string, unknown>) {
    return request(testApp.app)
      .put(`/api/vendor/products/${productId}`)
      .set('Authorization', token)
      .send(body);
  }

  function remove(token: string, productId: string) {
    return request(testApp.app)
      .delete(`/api/vendor/products/${productId}`)
      .set('Authorization', token);
  }

  function upload(token: string | null, productId: string, files: readonly UploadFile[]) {
    let req = request(testApp.app).post(`/api/vendor/products/${productId}/images`);
    if (token !== null) req = req.set('Authorization', token);
    for (const file of files) {
      req = req.attach(file.field ?? 'images', file.bytes, {
        filename: file.name ?? 'photo.jpg',
        contentType: file.type ?? 'image/jpeg',
      });
    }
    return req;
  }

  async function storedFiles(productId: string): Promise<string[]> {
    try {
      return await readdir(join(TEST_UPLOADS_DIR, 'product-images', productId));
    } catch {
      return [];
    }
  }

  const publicSearch = async (vendorId: string) =>
    bodyOf(
      productListResponseSchema,
      await request(testApp.app).get('/api/products').query({ vendor_id: vendorId }),
    ).products.map((p) => p.id);

  describe('PUT /api/vendor/products/:id', () => {
    it('replaces the details, price and category, and nothing else', async () => {
      const { vendorId, token } = await vendor();
      const other = await createCategory(db, { name: 'Lifecycle spices' });
      const productId = await createProduct(db, vendorId, 7, 250, {
        name: 'Old name',
        category_id: categoryId,
        image_urls: ['https://cdn.hamropasal.test/p/old.webp'],
      });
      const before = await rowOf(productId);
      const body = details({
        category_id: other,
        description: '  Orthodox black tea.  ',
        price_npr: 475.5,
        unit: 'pack',
        metadata: { brand: 'Ilam' },
      });

      const res = await put(token, productId, body);

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { product } = bodyOf(vendorProductResponseSchema, res);
      expect(product).toMatchObject({
        id: productId,
        category_id: other,
        name: body.name,
        description: 'Orthodox black tea.',
        price_npr: 475.5,
        unit: 'pack',
        metadata: { brand: 'Ilam' },
        is_active: true,
        // Not part of an edit: the stock, and photos the request did not list.
        stock_quantity: 7,
        image_urls: ['https://cdn.hamropasal.test/p/old.webp'],
      });
      const after = await rowOf(productId);
      expect(after).toMatchObject({ vendor_id: vendorId, category_id: other, price_npr: 475.5 });
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });

    it('takes defaults for omitted optional fields (PUT replaces)', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1, 100, {
        category_id: categoryId,
        description: 'To be cleared',
        unit: 'kg',
        metadata: { organic: true },
      });

      const res = await put(token, productId, details());

      expect(bodyOf(vendorProductResponseSchema, res).product).toMatchObject({
        description: null,
        unit: 'piece',
        metadata: {},
      });
    });

    it("Vendor A cannot edit Vendor B's product: 404, and the row is untouched", async () => {
      const a = await vendor();
      const b = await vendor();
      const theirs = await createProduct(db, b.vendorId, 3, 300, {
        name: 'Vendor B honey',
        category_id: categoryId,
      });
      const before = await rowOf(theirs);

      const res = await put(a.token, theirs, details({ name: 'Hijacked', price_npr: 1 }));

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRODUCT_NOT_FOUND');
      expect(await rowOf(theirs)).toEqual(before);
      // The owner still can.
      expect((await put(b.token, theirs, details({ price_npr: 310 }))).status).toBe(200);
      expect((await rowOf(theirs)).vendor_id).toBe(b.vendorId);
    });

    it('never moves a product to another shop: a vendor id in the body is refused', async () => {
      const a = await vendor();
      const b = await vendor();
      const mine = await createProduct(db, a.vendorId, 3, 300, { category_id: categoryId });

      const res = await put(a.token, mine, details({ vendor_id: b.vendorId }));

      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      expect((await rowOf(mine)).vendor_id).toBe(a.vendorId);
    });

    it('refuses the stock, a bad price, a blank name and a malformed id (400)', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 5, 100, { category_id: categoryId });
      const before = await rowOf(productId);

      const bad = await Promise.all([
        put(token, productId, details({ stock_quantity: 99 })),
        put(token, productId, details({ price_npr: 0 })),
        put(token, productId, details({ price_npr: 10.005 })),
        put(token, productId, details({ name: '   ' })),
        put(token, productId, { name: 'No category', price_npr: 5 }),
        put(token, productId, details({ image_urls: ['ftp://example.test/a.png'] })),
        put(token, 'not-a-uuid', details()),
      ]);

      for (const res of bad) {
        expect(res.status).toBe(400);
        expect(errorOf(res).code).toBe('VALIDATION_FAILED');
      }
      expect(await rowOf(productId)).toEqual(before);
    });

    it('refuses a move into an unknown or hidden category, but lets a product stay in one', async () => {
      const { vendorId, token } = await vendor();
      const hidden = await createCategory(db, { isActive: false });
      const productId = await createProduct(db, vendorId, 5, 100, { category_id: categoryId });
      const stranded = await createProduct(db, vendorId, 5, 100, { category_id: hidden });

      const unknown = await put(token, productId, details({ category_id: randomUUID() }));
      const intoHidden = await put(token, productId, details({ category_id: hidden }));
      const stays = await put(token, stranded, details({ category_id: hidden, price_npr: 120 }));

      for (const res of [unknown, intoHidden]) {
        expect(res.status).toBe(422);
        expect(errorOf(res).code).toBe('CATEGORY_UNAVAILABLE');
      }
      expect((await rowOf(productId)).category_id).toBe(categoryId);
      expect(stays.status).toBe(200);
      expect((await rowOf(stranded)).price_npr).toBe(120);
    });

    it("refuses another product's name in the same shop (409), allows keeping its own", async () => {
      const { vendorId, token } = await vendor();
      await createProduct(db, vendorId, 1, 100, { name: 'Taken name' });
      const productId = await createProduct(db, vendorId, 1, 100, { name: 'Own name' });

      const clash = await put(token, productId, details({ name: 'Taken name' }));
      const same = await put(token, productId, details({ name: 'Own name', price_npr: 130 }));

      expect(clash.status).toBe(409);
      expect(errorOf(clash).code).toBe('PRODUCT_NAME_TAKEN');
      expect(same.status).toBe(200);
      expect((await rowOf(productId)).name).toBe('Own name');
    });

    it('a new price is what checkout charges', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 5, 600, { category_id: categoryId });
      const customerId = await createUser(db);
      expect((await put(token, productId, details({ price_npr: 750 }))).status).toBe(200);

      const res = await request(testApp.app)
        .post('/api/cart/checkout')
        .set('Authorization', bearer(customerId))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'COD',
          items: [{ product_id: productId, quantity: 2 }],
          delivery_address: DELIVERY_ADDRESS,
        });

      expect(res.status).toBe(201);
      expect((res.body as { order: { subtotal_npr: number } }).order.subtotal_npr).toBe(1500);
    });

    it('answers 404 for an unknown product', async () => {
      const { token } = await vendor();

      const res = await put(token, randomUUID(), details());

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  describe('DELETE /api/vendor/products/:id', () => {
    it('hides the product (soft delete): the row stays, customers no longer see it', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 4, 250, { category_id: categoryId });
      const customerId = await createUser(db);
      expect(await publicSearch(vendorId)).toEqual([productId]);

      const res = await remove(token, productId);

      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(await rowOf(productId)).toMatchObject({ is_active: false, stock_quantity: 4 });
      expect(await publicSearch(vendorId)).toEqual([]);
      const menu = await request(testApp.app)
        .get(`/api/vendors/${vendorId}/products`)
        .query({ lat: '27.7154', lng: '85.3123' })
        .set('Authorization', bearer(customerId));
      expect(bodyOf(vendorMenuSchema, menu).products).toEqual([]);
      const checkout = await request(testApp.app)
        .post('/api/cart/checkout')
        .set('Authorization', bearer(customerId))
        .send({
          idempotency_key: randomUUID(),
          vendor_id: vendorId,
          payment_method: 'COD',
          items: [{ product_id: productId, quantity: 1 }],
          delivery_address: DELIVERY_ADDRESS,
        });
      expect(checkout.status).toBe(422);
      expect(errorOf(checkout).code).toBe('PRODUCT_UNAVAILABLE');
      // The vendor still lists it, as hidden.
      const mine = await request(testApp.app)
        .get('/api/vendor/products')
        .set('Authorization', token);
      expect((mine.body as { products: { id: string; is_active: boolean }[] }).products).toEqual([
        expect.objectContaining({ id: productId, is_active: false }),
      ]);
    });

    it('is idempotent, and PUT with is_active shows the product again', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 4, 250, { category_id: categoryId });

      expect((await remove(token, productId)).status).toBe(204);
      expect((await remove(token, productId)).status).toBe(204);
      expect((await rowOf(productId)).is_active).toBe(false);

      const hiddenEdit = await put(token, productId, details({ is_active: false }));
      expect(bodyOf(vendorProductResponseSchema, hiddenEdit).product.is_active).toBe(false);
      const shown = await put(token, productId, details());
      expect(bodyOf(vendorProductResponseSchema, shown).product.is_active).toBe(true);
      expect(await publicSearch(vendorId)).toEqual([productId]);
    });

    it("Vendor A cannot hide Vendor B's product", async () => {
      const a = await vendor();
      const b = await vendor();
      const theirs = await createProduct(db, b.vendorId, 3);

      const res = await remove(a.token, theirs);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRODUCT_NOT_FOUND');
      expect((await rowOf(theirs)).is_active).toBe(true);
      expect((await remove(a.token, randomUUID())).status).toBe(404);
      expect((await remove(a.token, 'not-a-uuid')).status).toBe(400);
    });
  });

  describe('POST /api/vendor/products/:id/images', () => {
    it('stores a multipart photo on disk, saves its URL in Postgres and serves it back', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1);
      const bytes = imageOfSize(2048);

      const res = await upload(token, productId, [{ bytes }]);

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { product } = bodyOf(vendorProductResponseSchema, res);
      expect(product.image_urls).toHaveLength(1);
      const [url] = product.image_urls;
      expect(url).toMatch(
        new RegExp(`^${TEST_UPLOADS_BASE_URL}/product-images/${productId}/[0-9a-f-]{36}\\.webp$`),
      );
      expect((await rowOf(productId)).image_urls).toEqual([url]);
      const [name] = await storedFiles(productId);
      expect(url?.endsWith(`/${name ?? ''}`)).toBe(true);
      // Re-encoded before it is stored (SPEC infrastructure §6): WebP, never the bytes as sent.
      const onDisk = await readFile(
        join(TEST_UPLOADS_DIR, 'product-images', productId, name ?? ''),
      );
      expect(await describeImage(onDisk)).toMatchObject({ format: 'webp', width: 64, height: 48 });

      const served = await request(testApp.app).get(new URL(url ?? '').pathname);
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/webp');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(served.body as Buffer)).toEqual(onDisk);
    });

    it('appends several photos of one request in order, after the ones already there', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1, 100, {
        image_urls: ['https://cdn.hamropasal.test/p/first.webp'],
      });

      const res = await upload(token, productId, [
        { bytes: imageOfSize(64) },
        { bytes: imageOfSize(64, PNG_SIGNATURE), name: 'b.png', type: 'image/png' },
      ]);

      expect(res.status).toBe(201);
      const urls = bodyOf(vendorProductResponseSchema, res).product.image_urls;
      expect(urls).toHaveLength(3);
      expect(urls[0]).toBe('https://cdn.hamropasal.test/p/first.webp');
      expect(urls[1]).toMatch(/\.webp$/);
      expect(urls[2]).toMatch(/\.webp$/);
      expect(await storedFiles(productId)).toHaveLength(2);
    });

    it('the public product list carries the uploaded URL', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1, 100, { category_id: categoryId });

      const res = await upload(token, productId, [{ bytes: imageOfSize(64) }]);

      const listed = bodyOf(
        productListResponseSchema,
        await request(testApp.app).get('/api/products').query({ vendor_id: vendorId }),
      );
      expect(listed.products[0]?.image_urls).toEqual(
        bodyOf(vendorProductResponseSchema, res).product.image_urls,
      );
    });

    it("Vendor A cannot add photos to Vendor B's product, and nothing is stored", async () => {
      const a = await vendor();
      const b = await vendor();
      const theirs = await createProduct(db, b.vendorId, 3);

      const res = await upload(a.token, theirs, [{ bytes: imageOfSize(64) }]);

      expect(res.status).toBe(404);
      expect(errorOf(res).code).toBe('PRODUCT_NOT_FOUND');
      expect((await rowOf(theirs)).image_urls).toEqual([]);
      expect(await storedFiles(theirs)).toEqual([]);
    });

    it('checks the bytes, not the declared type (415), and stores nothing of that request', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1);

      const res = await upload(token, productId, [
        { bytes: imageOfSize(64) },
        { bytes: Buffer.from('<svg onload="alert(1)"/>'), name: 'photo.jpg', type: 'image/jpeg' },
      ]);

      expect(res.status).toBe(415);
      expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect((await rowOf(productId)).image_urls).toEqual([]);
      expect(await storedFiles(productId)).toEqual([]);
    });

    it('accepts exactly 5 MB and rejects anything larger (413)', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1);

      const atLimit = await upload(token, productId, [
        { bytes: imageOfSize(MAX_PRODUCT_IMAGE_BYTES) },
      ]);
      const over = await upload(token, productId, [
        { bytes: imageOfSize(MAX_PRODUCT_IMAGE_BYTES + 1) },
      ]);

      expect(atLimit.status).toBe(201);
      expect(over.status).toBe(413);
      expect(errorOf(over)).toMatchObject({
        code: 'FILE_TOO_LARGE',
        details: { max_bytes: 5 * 1024 * 1024 },
      });
      expect(await storedFiles(productId)).toHaveLength(1);
    });

    it('stops at 8 photos per product (422), keeping what was there', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1);
      const photos = (count: number) =>
        Array.from({ length: count }, () => ({ bytes: imageOfSize(32) }));
      expect((await upload(token, productId, photos(7))).status).toBe(201);

      const twoMore = await upload(token, productId, photos(2));
      const nineAtOnce = await upload(token, productId, photos(9));
      const oneMore = await upload(token, productId, photos(1));
      const full = await upload(token, productId, photos(1));

      expect(twoMore.status).toBe(422);
      expect(errorOf(twoMore)).toMatchObject({
        code: 'PRODUCT_IMAGE_LIMIT',
        details: { max_images: MAX_PRODUCT_IMAGES, current_images: 7 },
      });
      expect(nineAtOnce.status).toBe(422);
      expect(errorOf(nineAtOnce).code).toBe('PRODUCT_IMAGE_LIMIT');
      expect(oneMore.status).toBe(201);
      expect(full.status).toBe(422);
      expect((await rowOf(productId)).image_urls).toHaveLength(8);
      expect(await storedFiles(productId)).toHaveLength(8);
    });

    it('never passes 8 photos when uploads race, and leaves no orphan files', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1);
      const three = () =>
        upload(
          token,
          productId,
          Array.from({ length: 3 }, () => ({ bytes: imageOfSize(32) })),
        );

      const responses = await Promise.all([three(), three(), three(), three()]);

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses).toEqual([201, 201, 422, 422]);
      const urls = (await rowOf(productId)).image_urls;
      expect(urls).toHaveLength(6);
      expect((await storedFiles(productId)).sort()).toEqual(
        urls.map((url) => url.split('/').at(-1)).sort(),
      );
    });

    it('requires at least one file in the `images` field, and no other parts (400)', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1);

      const none = await request(testApp.app)
        .post(`/api/vendor/products/${productId}/images`)
        .set('Authorization', token)
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x--\r\n');
      const json = await request(testApp.app)
        .post(`/api/vendor/products/${productId}/images`)
        .set('Authorization', token)
        .send({ images: ['https://cdn.hamropasal.test/p/a.webp'] });
      const wrongField = await upload(token, productId, [
        { bytes: imageOfSize(32), field: 'file' },
      ]);
      const withField = await upload(token, productId, [{ bytes: imageOfSize(32) }]).field(
        'vendor_id',
        randomUUID(),
      );
      const badId = await upload(token, 'not-a-uuid', [{ bytes: imageOfSize(32) }]);

      expect(none.status).toBe(400);
      expect(errorOf(none).code).toBe('VALIDATION_FAILED');
      expect(json.status).toBe(400);
      expect(errorOf(json).code).toBe('VALIDATION_FAILED');
      expect(wrongField.status).toBe(400);
      expect(errorOf(wrongField).code).toBe('MALFORMED_REQUEST');
      expect(withField.status).toBe(400);
      expect(errorOf(withField).code).toBe('MALFORMED_REQUEST');
      expect(badId.status).toBe(400);
      expect((await rowOf(productId)).image_urls).toEqual([]);
      expect(await storedFiles(productId)).toEqual([]);
    });

    it('PUT with a photo list removes the dropped photos, file included', async () => {
      const { vendorId, token } = await vendor();
      const productId = await createProduct(db, vendorId, 1, 100, { category_id: categoryId });
      const uploaded = await upload(token, productId, [
        { bytes: imageOfSize(32) },
        { bytes: imageOfSize(32) },
      ]);
      const [first, second] = bodyOf(vendorProductResponseSchema, uploaded).product.image_urls;

      const res = await put(token, productId, details({ image_urls: [second] }));

      expect(bodyOf(vendorProductResponseSchema, res).product.image_urls).toEqual([second]);
      const files = await storedFiles(productId);
      expect(files).toEqual([second?.split('/').at(-1)]);
      expect((await request(testApp.app).get(new URL(first ?? '').pathname)).status).toBe(404);
    });
  });

  describe('roles', () => {
    it('serves vendors only; a vendor account without a shop gets 404', async () => {
      const productId = await createProduct(db, await createVendor(db), 1);

      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as const) {
        const token = bearer(await createUser(db, role), role);
        for (const res of [
          await put(token, productId, details()),
          await remove(token, productId),
          await upload(token, productId, [{ bytes: imageOfSize(32) }]),
        ]) {
          expect(res.status).toBe(403);
          expect(errorOf(res).code).toBe('FORBIDDEN');
        }
      }
      expect((await upload(null, productId, [{ bytes: imageOfSize(32) }])).status).toBe(401);

      const shopless = bearer(await createUser(db, 'VENDOR'), 'VENDOR');
      for (const res of [
        await put(shopless, productId, details()),
        await remove(shopless, productId),
        await upload(shopless, productId, [{ bytes: imageOfSize(32) }]),
      ]) {
        expect(res.status).toBe(404);
        expect(errorOf(res).code).toBe('VENDOR_NOT_FOUND');
      }
      expect(await rowOf(productId)).toMatchObject({ is_active: true, image_urls: [] });
      expect(await storedFiles(productId)).toEqual([]);
    });
  });
});

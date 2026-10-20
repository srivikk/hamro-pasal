import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { auditLogs, homePromotions, orders, vendors, type Database } from '@hamro-pasal/db';
import {
  adminComplianceVendorListResponseSchema,
  adminPromotionResponseSchema,
  auditLogSchema,
  disputeEvidenceUploadResponseSchema,
  panDocumentUploadResponseSchema,
  promotionImageUploadResponseSchema,
  taxIdentityResponseSchema,
  taxIdentityViewSchema,
  vendorProductResponseSchema,
  type UserRole,
} from '@hamro-pasal/shared-types';
import { asc, eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { s3FileStorage } from '../src/uploads/storage-from-env';
import { FakeS3 } from './support/fake-s3';
import {
  createCategory,
  createOrder,
  createProduct,
  createUser,
  createVendor,
  markDelivered,
  vendorUserIdOf,
} from './support/fixtures';
import {
  bearer,
  bodyOf,
  buildTestApp,
  errorOf,
  TEST_PRIVATE_UPLOADS_DIR,
  TEST_UPLOADS_DIR,
  type TestApp,
} from './support/http';
import { describeImage, noisyJpeg, paddedTo, photo } from './support/images';

const CDN = 'https://cdn.hamropasal.test';
const PUBLIC = 'hp-public';
const PRIVATE = 'hp-private';

/**
 * Phase 34: the API on an S3-compatible bucket (an in-memory S3 standing where the SDK client
 * does, so the commands are the real ones), with real PostgreSQL.
 *
 * - every upload is stored as WebP, at most 1200 px and under 300 KB;
 * - POST / DELETE /api/admin/promotions/image, and a promotion's artwork deleted when it is
 *   replaced or the promotion goes;
 * - POST /api/vendor/tax-identity/document: the PAN document in the private bucket, the old one
 *   deleted, and what is left behind when either system fails half way;
 * - GET /api/admin/vendors/:id/pan-document, the only way to the bytes.
 */
describe('cloud storage and vendor KYC', () => {
  let s3: FakeS3;
  let cloud: TestApp;
  let local: TestApp;
  let db: Database;
  let adminToken: string;
  let adminId: string;
  let jpeg: Buffer;
  let warnings: jest.SpyInstance<void, unknown[]>;

  beforeAll(async () => {
    s3 = new FakeS3();
    cloud = buildTestApp({
      fileStorage: s3FileStorage(s3, {
        publicBucket: PUBLIC,
        privateBucket: PRIVATE,
        publicBaseUrl: CDN,
      }),
    });
    local = buildTestApp();
    db = cloud.container.db;
    adminId = await createUser(db, 'SUPER_ADMIN');
    adminToken = bearer(adminId, 'SUPER_ADMIN');
    jpeg = await photo({ width: 320, height: 200 });
  });

  beforeEach(() => {
    s3.failing.clear();
    s3.log.length = 0;
    warnings = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnings.mockRestore();
  });

  afterAll(async () => {
    await cloud.container.close();
    await local.container.close();
    await rm(TEST_UPLOADS_DIR, { recursive: true, force: true });
    await rm(TEST_PRIVATE_UPLOADS_DIR, { recursive: true, force: true });
  });

  async function shop(options: Parameters<typeof createVendor>[1] = {}) {
    const vendorId = await createVendor(db, options);
    const userId = await vendorUserIdOf(db, vendorId);
    return { vendorId, userId, token: bearer(userId, 'VENDOR') };
  }

  const vendorRow = async (vendorId: string) => {
    const [row] = await db.select().from(vendors).where(eq(vendors.id, vendorId));
    if (row === undefined) throw new Error('vendor not found');
    return row;
  };

  const deletes = () => s3.log.filter((entry) => entry.operation === 'DeleteObject');
  const keyOfUrl = (url: string) => url.slice(CDN.length + 1);
  const publicObject = (url: string) => s3.objects.get(`${PUBLIC}/${keyOfUrl(url)}`);

  interface Part {
    readonly bytes: Buffer;
    readonly field?: string;
    readonly name?: string;
    readonly type?: string;
  }

  function multipart(app: TestApp, path: string, token: string | null, parts: readonly Part[]) {
    let req = request(app.app).post(path);
    if (token !== null) req = req.set('authorization', token);
    for (const part of parts) {
      req = req.attach(part.field ?? '', part.bytes, {
        filename: part.name ?? 'upload.jpg',
        contentType: part.type ?? 'image/jpeg',
      });
    }
    return req;
  }

  // ------------------------------------------------------------------------------------------
  describe('POST /api/admin/promotions/image', () => {
    const upload = (token: string | null, parts: readonly Part[], app = cloud) =>
      multipart(
        app,
        '/api/admin/promotions/image',
        token,
        parts.map((part) => ({ field: 'image', ...part })),
      );

    async function uploaded(bytes = jpeg): Promise<string> {
      const res = await upload(adminToken, [{ bytes }]);
      expect(res.status).toBe(201);
      return bodyOf(promotionImageUploadResponseSchema, res).url;
    }

    const promotionBody = (overrides: Record<string, unknown> = {}) => ({
      placement: 'CAROUSEL',
      image_url: null,
      title: 'Dashain offers',
      subtitle: null,
      target_type: null,
      target_value: null,
      display_order: 0,
      is_active: true,
      starts_at: null,
      ends_at: null,
      is_sponsored: false,
      ad_purchase_id: null,
      ...overrides,
    });

    async function promotionWith(imageUrl: string | null, placement = 'CAROUSEL') {
      const res = await request(cloud.app)
        .post('/api/admin/promotions')
        .set('authorization', adminToken)
        .send(promotionBody({ image_url: imageUrl, placement }));
      expect(res.status).toBe(201);
      return bodyOf(adminPromotionResponseSchema, res).promotion;
    }

    const putPromotion = (id: string, imageUrl: string | null, placement = 'CAROUSEL') =>
      request(cloud.app)
        .put(`/api/admin/promotions/${id}`)
        .set('authorization', adminToken)
        .send(promotionBody({ image_url: imageUrl, placement }));

    const deletePromotion = (id: string) =>
      request(cloud.app).delete(`/api/admin/promotions/${id}`).set('authorization', adminToken);

    const discard = (url: unknown, token = adminToken) =>
      request(cloud.app)
        .delete('/api/admin/promotions/image')
        .set('authorization', token)
        .send({ url });

    it('stores the image in the public bucket and answers its absolute public URL', async () => {
      const res = await upload(adminToken, [{ bytes: jpeg }]);

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { url } = bodyOf(promotionImageUploadResponseSchema, res);
      expect(url).toMatch(new RegExp(`^${CDN}/promotions/[0-9a-f-]{36}\\.webp$`));
      const object = publicObject(url);
      expect(object).toMatchObject({
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      expect(await describeImage(object?.body ?? Buffer.alloc(0))).toMatchObject({
        format: 'webp',
        width: 320,
        height: 200,
      });
      expect(s3.log).toEqual([{ operation: 'PutObject', bucket: PUBLIC, key: keyOfUrl(url) }]);
    });

    it('stores a large banner at 1200 px at most and under 300 KB, as WebP', async () => {
      const url = await uploaded(await noisyJpeg());

      const stored = await describeImage(publicObject(url)?.body ?? Buffer.alloc(0));
      expect(stored).toMatchObject({ format: 'webp', width: 1200, height: 900 });
      expect(stored.bytes).toBeLessThan(300 * 1024);
    });

    it('accepts PNG and WebP by their own bytes, whatever the part says it is', async () => {
      for (const format of ['png', 'webp'] as const) {
        const res = await upload(adminToken, [
          { bytes: await photo({ format }), name: 'banner.txt', type: 'text/plain' },
        ]);
        expect(res.status).toBe(201);
      }
    });

    it('refuses what is not an image (415) and stores nothing', async () => {
      const before = s3.keys(PUBLIC);
      const signatureOnly = Buffer.alloc(4096, 0x20);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(signatureOnly);

      for (const bytes of [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
        Buffer.from('%PDF-1.7 a document'),
        Buffer.from('GIF89a not accepted'),
        signatureOnly,
      ]) {
        const res = await upload(adminToken, [{ bytes, name: 'banner.png', type: 'image/png' }]);
        expect(res.status).toBe(415);
        expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      }
      expect(s3.keys(PUBLIC)).toEqual(before);
      expect(s3.log).toEqual([]);
    });

    it('accepts exactly 5 MB and refuses one byte more (413)', async () => {
      const atLimit = await upload(adminToken, [{ bytes: paddedTo(jpeg, 5 * 1024 * 1024) }]);
      const over = await upload(adminToken, [{ bytes: paddedTo(jpeg, 5 * 1024 * 1024 + 1) }]);

      expect(atLimit.status).toBe(201);
      expect(over.status).toBe(413);
      expect(errorOf(over)).toMatchObject({
        code: 'FILE_TOO_LARGE',
        details: { max_bytes: 5 * 1024 * 1024 },
      });
    });

    it('takes exactly one `image` part and nothing else (400)', async () => {
      const none = await request(cloud.app)
        .post('/api/admin/promotions/image')
        .set('authorization', adminToken)
        .field('note', 'no file');
      const json = await request(cloud.app)
        .post('/api/admin/promotions/image')
        .set('authorization', adminToken)
        .send({ image: 'https://example.test/a.png' });
      const wrongField = await upload(adminToken, [{ bytes: jpeg, field: 'file' }]);
      const two = await upload(adminToken, [{ bytes: jpeg }, { bytes: jpeg }]);
      const withField = await upload(adminToken, [{ bytes: jpeg }]).field('url', 'x');

      expect(json.status).toBe(400);
      expect(errorOf(json).code).toBe('VALIDATION_FAILED');
      for (const res of [none, wrongField, two, withField]) {
        expect(res.status).toBe(400);
        expect(['MALFORMED_REQUEST', 'VALIDATION_FAILED']).toContain(errorOf(res).code);
      }
      expect(s3.log).toEqual([]);
    });

    it('serves Super Admins only', async () => {
      expect((await upload(null, [{ bytes: jpeg }])).status).toBe(401);
      for (const role of ['CUSTOMER', 'VENDOR', 'DRIVER'] as const satisfies readonly UserRole[]) {
        const res = await upload(bearer(await createUser(db, role), role), [{ bytes: jpeg }]);
        expect(res.status).toBe(403);
      }
      expect(s3.log).toEqual([]);
    });

    it('answers 500 and keeps nothing when the bucket refuses the object', async () => {
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      s3.failing.add('PutObject');
      const before = s3.keys(PUBLIC);

      const res = await upload(adminToken, [{ bytes: jpeg }]);

      expect(res.status).toBe(500);
      expect(errorOf(res).code).toBe('INTERNAL_SERVER_ERROR');
      expect(s3.keys(PUBLIC)).toEqual(before);
      errors.mockRestore();
    });

    describe('the artwork of a promotion', () => {
      it('is deleted from the bucket when the promotion gets another image', async () => {
        const first = await uploaded();
        const second = await uploaded();
        const promotion = await promotionWith(first);
        s3.log.length = 0;

        const res = await putPromotion(promotion.id, second);

        expect(res.status).toBe(200);
        expect(bodyOf(adminPromotionResponseSchema, res).promotion.image_url).toBe(second);
        expect(publicObject(first)).toBeUndefined();
        expect(publicObject(second)).toBeDefined();
        expect(deletes()).toEqual([
          { operation: 'DeleteObject', bucket: PUBLIC, key: keyOfUrl(first) },
        ]);
      });

      it('is deleted when the image is taken off, and when the promotion is deleted', async () => {
        const first = await uploaded();
        const second = await uploaded();
        const tile = await promotionWith(first, 'FEATURED');
        const banner = await promotionWith(second);

        expect((await putPromotion(tile.id, null, 'FEATURED')).status).toBe(200);
        expect((await deletePromotion(banner.id)).status).toBe(204);

        expect(publicObject(first)).toBeUndefined();
        expect(publicObject(second)).toBeUndefined();
      });

      it('is kept on an edit that leaves the image as it is', async () => {
        const url = await uploaded();
        const promotion = await promotionWith(url);
        s3.log.length = 0;

        expect((await putPromotion(promotion.id, url)).status).toBe(200);

        expect(publicObject(url)).toBeDefined();
        expect(deletes()).toEqual([]);
      });

      it('is kept while another promotion still uses it, and deleted with the last one', async () => {
        const url = await uploaded();
        const one = await promotionWith(url);
        const two = await promotionWith(url);

        expect((await deletePromotion(one.id)).status).toBe(204);
        expect(publicObject(url)).toBeDefined();

        expect((await deletePromotion(two.id)).status).toBe(204);
        expect(publicObject(url)).toBeUndefined();
      });

      it('is never touched when it is a URL this API did not issue', async () => {
        const pasted = 'https://picsum.photos/seed/dashain/1200/600';
        const lookalike = `${CDN}/promotions/../product-images/x.webp`;
        const one = await promotionWith(pasted);
        const two = await promotionWith(lookalike);
        s3.log.length = 0;

        expect((await putPromotion(one.id, await uploaded())).status).toBe(200);
        expect((await deletePromotion(two.id)).status).toBe(204);

        expect(deletes()).toEqual([]);
      });

      it('stays behind as a logged orphan when the bucket cannot delete: the edit still stands', async () => {
        const first = await uploaded();
        const second = await uploaded();
        const promotion = await promotionWith(first);
        s3.failing.add('DeleteObject');

        const res = await putPromotion(promotion.id, second);

        expect(res.status).toBe(200);
        const [row] = await db
          .select()
          .from(homePromotions)
          .where(eq(homePromotions.id, promotion.id));
        expect(row?.image_url).toBe(second);
        expect(publicObject(first)).toBeDefined();
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toMatchObject({
          storage: 'orphan_object',
          kind: 'promotion_image',
          url: first,
        });
      });

      it('is not deleted when the write that would replace it is refused', async () => {
        const url = await uploaded();
        const promotion = await promotionWith(url);
        s3.log.length = 0;

        // A carousel banner needs its image: 400, nothing changes.
        const res = await putPromotion(promotion.id, null);

        expect(res.status).toBe(400);
        expect(publicObject(url)).toBeDefined();
        expect(deletes()).toEqual([]);
      });
    });

    describe('DELETE /api/admin/promotions/image', () => {
      it('deletes an uploaded image no promotion uses (204, also on repeat)', async () => {
        const url = await uploaded();

        expect((await discard(url)).status).toBe(204);
        expect((await discard(url)).status).toBe(204);

        expect(publicObject(url)).toBeUndefined();
      });

      it('refuses while a promotion uses the image (409)', async () => {
        const url = await uploaded();
        await promotionWith(url);

        const res = await discard(url);

        expect(res.status).toBe(409);
        expect(errorOf(res).code).toBe('PROMOTION_IMAGE_IN_USE');
        expect(publicObject(url)).toBeDefined();
      });

      it('leaves any other URL alone, and other buckets’ objects with it', async () => {
        const { vendorId, token } = await shop();
        const productId = await createProduct(db, vendorId, 1);
        const photoUrl =
          bodyOf(
            vendorProductResponseSchema,
            await multipart(cloud, `/api/vendor/products/${productId}/images`, token, [
              { bytes: jpeg, field: 'images' },
            ]),
          ).product.image_urls[0] ?? '';
        s3.log.length = 0;

        for (const url of [photoUrl, 'https://picsum.photos/id/1/800/400', `${CDN}/promotions/x`]) {
          expect((await discard(url)).status).toBe(204);
        }

        expect(deletes()).toEqual([]);
        expect(publicObject(photoUrl)).toBeDefined();
      });

      it('needs a URL (400) and a Super Admin (403)', async () => {
        const url = await uploaded();
        const vendor = await shop();

        expect((await discard('not a url')).status).toBe(400);
        expect((await discard(undefined)).status).toBe(400);
        expect((await discard(url, vendor.token)).status).toBe(403);
        expect(publicObject(url)).toBeDefined();
      });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('POST /api/vendor/tax-identity/document', () => {
    const upload = (token: string | null, parts: readonly Part[], app = cloud) =>
      multipart(
        app,
        '/api/vendor/tax-identity/document',
        token,
        parts.map((part) => ({ field: 'document', ...part })),
      );

    async function uploaded(token: string, bytes = jpeg) {
      const res = await upload(token, [{ bytes }]);
      expect(res.status).toBe(201);
      return bodyOf(panDocumentUploadResponseSchema, res);
    }

    const documentsOf = (vendorId: string) =>
      s3.keys(PRIVATE).filter((key) => key.startsWith(`kyc/pan/${vendorId}/`));

    const auditOf = (vendorId: string) =>
      db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.entity_id, vendorId))
        .orderBy(asc(auditLogs.occurred_at));

    const verify = (vendorId: string) =>
      db
        .update(vendors)
        .set({ tax_id: '302118845', pan_verified_at: sql`now()`, pan_verified_by_user_id: adminId })
        .where(eq(vendors.id, vendorId));

    it('stores the document in the private bucket and records where, with its audit entry', async () => {
      const { vendorId, userId, token } = await shop();

      const res = await upload(token, [{ bytes: jpeg }]);

      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(bodyOf(panDocumentUploadResponseSchema, res)).toEqual({
        vendor_id: vendorId,
        has_pan_document: true,
        replaced: false,
        verification_cleared: false,
        pan_verified_at: null,
      });
      const [key] = documentsOf(vendorId);
      expect(key).toMatch(new RegExp(`^kyc/pan/${vendorId}/[0-9a-f-]{36}\\.webp$`));
      expect((await vendorRow(vendorId)).pan_document_url).toBe(key);
      const object = s3.objects.get(`${PRIVATE}/${key ?? ''}`);
      expect(object).toMatchObject({
        contentType: 'image/webp',
        cacheControl: 'private, no-store',
      });
      expect(await describeImage(object?.body ?? Buffer.alloc(0))).toMatchObject({
        format: 'webp',
        width: 320,
        height: 200,
      });
      // Nothing of it in the public bucket, and nowhere in the answer.
      expect(s3.log).toEqual([{ operation: 'PutObject', bucket: PRIVATE, key }]);
      expect(JSON.stringify(res.body)).not.toContain('kyc/');

      const entries = (await auditOf(vendorId)).map((entry) => auditLogSchema.parse(entry));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: 'PAN_DOCUMENT_UPLOADED',
        actor_user_id: userId,
        actor_role: 'VENDOR',
        vendor_id: vendorId,
        before_state: { pan_document_url: null },
        after_state: { pan_document_url: key },
        request_id: res.headers['x-request-id'],
      });
    });

    it('compresses a camera photo to 1200 px and under 300 KB before it is stored', async () => {
      const { vendorId, token } = await shop();

      await uploaded(token, await noisyJpeg());

      const [key] = documentsOf(vendorId);
      const stored = await describeImage(
        s3.objects.get(`${PRIVATE}/${key ?? ''}`)?.body ?? Buffer.alloc(0),
      );
      expect(stored).toMatchObject({ format: 'webp', width: 1200, height: 900 });
      expect(stored.bytes).toBeLessThan(300 * 1024);
    });

    it('replaces an earlier document and deletes its object, after the row has moved on', async () => {
      const { vendorId, token } = await shop();
      await uploaded(token);
      const [firstKey] = documentsOf(vendorId);
      s3.log.length = 0;

      const second = await uploaded(token, await photo({ width: 400, height: 300, format: 'png' }));

      expect(second).toMatchObject({ replaced: true, verification_cleared: false });
      const keys = documentsOf(vendorId);
      expect(keys).toHaveLength(1);
      expect(keys[0]).not.toBe(firstKey);
      expect((await vendorRow(vendorId)).pan_document_url).toBe(keys[0]);
      // Put the new one, then (after the commit) delete the old one: never the other way round.
      expect(s3.log).toEqual([
        { operation: 'PutObject', bucket: PRIVATE, key: keys[0] },
        { operation: 'DeleteObject', bucket: PRIVATE, key: firstKey },
      ]);
      const entries = await auditOf(vendorId);
      expect(entries.at(-1)).toMatchObject({
        action: 'PAN_DOCUMENT_UPLOADED',
        before_state: { pan_document_url: firstKey },
        after_state: { pan_document_url: keys[0] },
      });
    });

    it('clears a verification when the verified document is replaced, taking the shop offline, not on a first document', async () => {
      const first = await shop();
      await verify(first.vendorId);
      const firstUpload = await uploaded(first.token);
      expect(firstUpload).toMatchObject({ replaced: false, verification_cleared: false });
      expect(firstUpload.pan_verified_at).not.toBeNull();
      expect((await vendorRow(first.vendorId)).pan_verified_at).not.toBeNull();

      const replacement = await uploaded(first.token);

      expect(replacement).toEqual({
        vendor_id: first.vendorId,
        has_pan_document: true,
        replaced: true,
        verification_cleared: true,
        pan_verified_at: null,
      });
      const row = await vendorRow(first.vendorId);
      expect(row).toMatchObject({
        pan_verified_at: null,
        pan_verified_by_user_id: null,
        tax_id: '302118845',
        // SPEC core 10 (amended 2026-10-20): the Super Admin checked the document now gone.
        status: 'SUSPENDED_COMPLIANCE',
        status_before_compliance_suspension: 'LIVE',
      });
      const actions = (await auditOf(first.vendorId)).map((entry) => entry.action);
      expect(actions).toEqual([
        'PAN_DOCUMENT_UPLOADED',
        'VENDOR_SUSPENDED_FOR_COMPLIANCE',
        'PAN_DOCUMENT_UPLOADED',
        'PAN_VERIFICATION_CLEARED',
      ]);
    });

    it('five uploads at once leave exactly one document: the one the row names', async () => {
      const { vendorId, token } = await shop();

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => upload(token, [{ bytes: jpeg }])),
      );

      expect(responses.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
      expect(
        responses.filter((res) => !bodyOf(panDocumentUploadResponseSchema, res).replaced),
      ).toHaveLength(1);
      const keys = documentsOf(vendorId);
      expect(keys).toEqual([(await vendorRow(vendorId)).pan_document_url]);
      expect(await auditOf(vendorId)).toHaveLength(5);
    });

    it('never touches another shop’s document', async () => {
      const mine = await shop();
      const theirs = await shop();
      await uploaded(theirs.token);
      const [theirKey] = documentsOf(theirs.vendorId);

      await uploaded(mine.token);
      await uploaded(mine.token);

      expect(documentsOf(theirs.vendorId)).toEqual([theirKey]);
      expect((await vendorRow(theirs.vendorId)).pan_document_url).toBe(theirKey);
      expect(documentsOf(mine.vendorId)).toHaveLength(1);
    });

    it('a shop suspended for compliance can upload: the document alone does not lift it', async () => {
      const { vendorId, token } = await shop();
      await db.execute(
        sql`UPDATE vendors SET status = 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension = status
            WHERE id = ${vendorId}`,
      );

      await uploaded(token);

      expect(await vendorRow(vendorId)).toMatchObject({
        status: 'SUSPENDED_COMPLIANCE',
        tax_id: null,
      });
      expect(documentsOf(vendorId)).toHaveLength(1);
    });

    describe('when one of the two systems fails', () => {
      it('the bucket refuses the new object: 500, the row and the old document are untouched', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { vendorId, token } = await shop();
        await uploaded(token);
        const [key] = documentsOf(vendorId);
        s3.failing.add('PutObject');

        const res = await upload(token, [{ bytes: jpeg }]);

        expect(res.status).toBe(500);
        expect(documentsOf(vendorId)).toEqual([key]);
        expect((await vendorRow(vendorId)).pan_document_url).toBe(key);
        expect(await auditOf(vendorId)).toHaveLength(1);
        errors.mockRestore();
      });

      it('the database refuses the row: the new object is deleted, the old one stays', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const { vendorId, token } = await shop();
        await uploaded(token);
        const [key] = documentsOf(vendorId);
        s3.log.length = 0;
        await db.execute(sql`
          CREATE OR REPLACE FUNCTION test_refuse_pan_document() RETURNS trigger AS $$
          BEGIN RAISE EXCEPTION 'simulated database failure'; END $$ LANGUAGE plpgsql`);
        await db.execute(
          sql.raw(`CREATE TRIGGER test_refuse_pan_document BEFORE UPDATE ON vendors
                   FOR EACH ROW WHEN (NEW.id = '${vendorId}') EXECUTE FUNCTION test_refuse_pan_document()`),
        );
        let res: request.Response;
        try {
          res = await upload(token, [{ bytes: jpeg }]);
        } finally {
          await db.execute(sql`DROP TRIGGER test_refuse_pan_document ON vendors`);
          await db.execute(sql`DROP FUNCTION test_refuse_pan_document()`);
        }

        expect(res.status).toBe(500);
        expect(documentsOf(vendorId)).toEqual([key]);
        expect((await vendorRow(vendorId)).pan_document_url).toBe(key);
        expect(await auditOf(vendorId)).toHaveLength(1);
        // The object that was put for the refused upload is the one that was deleted.
        expect(s3.log.map((entry) => entry.operation)).toEqual(['PutObject', 'DeleteObject']);
        expect(s3.log[0]?.key).toBe(s3.log[1]?.key);
        expect(s3.log[0]?.key).not.toBe(key);
        errors.mockRestore();
      });

      it('the bucket cannot delete the old object: the upload stands, the orphan is logged', async () => {
        const { vendorId, token } = await shop();
        await uploaded(token);
        const [oldKey] = documentsOf(vendorId);
        s3.failing.add('DeleteObject');

        const res = await upload(token, [{ bytes: jpeg }]);

        expect(res.status).toBe(201);
        const newKey = (await vendorRow(vendorId)).pan_document_url;
        expect(newKey).not.toBe(oldKey);
        expect(documentsOf(vendorId).sort()).toEqual([oldKey, newKey].sort());
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toMatchObject({
          storage: 'orphan_object',
          kind: 'pan_document',
          key: oldKey,
        });
      });
    });

    it('refuses what is not an image (415), too large (413) or malformed (400), storing nothing', async () => {
      const { vendorId, token } = await shop();

      const pdf = await upload(token, [
        { bytes: Buffer.from('%PDF-1.7 pan certificate'), name: 'pan.jpg' },
      ]);
      const tooLarge = await upload(token, [{ bytes: paddedTo(jpeg, 5 * 1024 * 1024 + 1) }]);
      const none = await request(cloud.app)
        .post('/api/vendor/tax-identity/document')
        .set('authorization', token)
        .send({ document: 'kyc/pan/somewhere.webp' });
      const wrongField = await upload(token, [{ bytes: jpeg, field: 'file' }]);
      const two = await upload(token, [{ bytes: jpeg }, { bytes: jpeg }]);
      const withField = await upload(token, [{ bytes: jpeg }]).field('vendor_id', vendorId);

      expect(pdf.status).toBe(415);
      expect(errorOf(pdf).code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(tooLarge.status).toBe(413);
      expect(errorOf(tooLarge).code).toBe('FILE_TOO_LARGE');
      expect(none.status).toBe(400);
      expect(errorOf(none).code).toBe('VALIDATION_FAILED');
      for (const res of [wrongField, two, withField]) expect(res.status).toBe(400);
      expect(documentsOf(vendorId)).toEqual([]);
      expect((await vendorRow(vendorId)).pan_document_url).toBeNull();
      expect(s3.log).toEqual([]);
    });

    it('serves vendors only; a vendor account without a shop gets 404 and stores nothing', async () => {
      expect((await upload(null, [{ bytes: jpeg }])).status).toBe(401);
      for (const role of ['CUSTOMER', 'DRIVER', 'SUPER_ADMIN'] as const) {
        const res = await upload(bearer(await createUser(db, role), role), [{ bytes: jpeg }]);
        expect(res.status).toBe(403);
      }
      const shopless = await upload(bearer(await createUser(db, 'VENDOR'), 'VENDOR'), [
        { bytes: jpeg },
      ]);
      expect(shopless.status).toBe(404);
      expect(errorOf(shopless).code).toBe('VENDOR_NOT_FOUND');
      expect(s3.log).toEqual([]);
    });

    describe('strict KYC: one document per PAN number (Phase 35)', () => {
      const savePan = (token: string, taxId: string, isVatRegistered = false) =>
        request(cloud.app)
          .put('/api/vendor/tax-identity')
          .set('authorization', token)
          .send({ tax_id: taxId, is_vat_registered: isVatRegistered });

      const verifyByAdmin = (vendorId: string) =>
        request(cloud.app)
          .post(`/api/admin/vendors/${vendorId}/pan-verification`)
          .set('authorization', adminToken);

      it('verifies only once a document is on file: 422 DOCUMENT_MISSING before the upload', async () => {
        const { vendorId, token } = await shop();
        expect((await savePan(token, '302118845', true)).status).toBe(200);

        const early = await verifyByAdmin(vendorId);

        expect(early.status).toBe(422);
        expect(errorOf(early)).toMatchObject({
          code: 'DOCUMENT_MISSING',
          details: { vendor_id: vendorId },
        });
        expect((await vendorRow(vendorId)).pan_verified_at).toBeNull();

        await uploaded(token);
        const res = await verifyByAdmin(vendorId);

        expect(res.status).toBe(200);
        expect(await vendorRow(vendorId)).toMatchObject({
          is_vat_registered: true,
          pan_verified_by_user_id: adminId,
        });
        expect((await vendorRow(vendorId)).pan_verified_at).toBeInstanceOf(Date);
      });

      it('removes the document when the PAN number changes: row first, then the object', async () => {
        const { vendorId, token } = await shop();
        await savePan(token, '302118845');
        await uploaded(token);
        const [oldKey] = documentsOf(vendorId);
        expect((await verifyByAdmin(vendorId)).status).toBe(200);
        s3.log.length = 0;

        const res = await savePan(token, '609871234', true);

        expect(res.status).toBe(200);
        expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
          tax_id: '609871234',
          is_vat_registered: true,
          pan_verified_at: null,
          pan_document_removed: true,
          has_pan_document: false,
        });
        expect(await vendorRow(vendorId)).toMatchObject({
          tax_id: '609871234',
          pan_document_url: null,
          pan_verified_at: null,
          pan_verified_by_user_id: null,
          status: 'SUSPENDED_COMPLIANCE',
        });
        // Exactly the old number's document, deleted from the private bucket.
        expect(s3.log).toEqual([{ operation: 'DeleteObject', bucket: PRIVATE, key: oldKey }]);
        expect(documentsOf(vendorId)).toEqual([]);
        const removed = (await auditOf(vendorId)).find(
          (entry) => entry.action === 'PAN_DOCUMENT_REMOVED',
        );
        expect(removed).toMatchObject({
          before_state: { tax_id: '302118845', pan_document_url: oldKey },
          after_state: { tax_id: '609871234', pan_document_url: null, reason: 'PAN_CHANGED' },
        });
        expect(JSON.stringify(res.body)).not.toContain('kyc/');

        // Nothing to show an admin, and nothing to verify, until the matching document arrives.
        const read = await request(cloud.app)
          .get(`/api/admin/vendors/${vendorId}/pan-document`)
          .set('authorization', adminToken);
        expect(read.status).toBe(404);
        expect(errorOf(await verifyByAdmin(vendorId)).code).toBe('DOCUMENT_MISSING');

        await uploaded(token);
        expect((await verifyByAdmin(vendorId)).status).toBe(200);
        expect(documentsOf(vendorId)).toHaveLength(1);
        expect(documentsOf(vendorId)).not.toContain(oldKey);
      });

      it('keeps the document when the same PAN is saved again with other details', async () => {
        const { vendorId, token } = await shop();
        await savePan(token, '302118845');
        await uploaded(token);
        const [key] = documentsOf(vendorId);
        expect((await verifyByAdmin(vendorId)).status).toBe(200);
        s3.log.length = 0;

        const res = await savePan(token, '302118845', true);

        expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
          is_vat_registered: true,
          pan_document_removed: false,
          has_pan_document: true,
        });
        expect(bodyOf(taxIdentityResponseSchema, res).pan_verified_at).toEqual(expect.any(String));
        expect((await vendorRow(vendorId)).pan_document_url).toBe(key);
        expect(s3.log).toEqual([]);
      });

      it('keeps a document uploaded before the first PAN: a first number is not a change', async () => {
        const { vendorId, token } = await shop();
        await uploaded(token);
        const [key] = documentsOf(vendorId);
        s3.log.length = 0;

        const res = await savePan(token, '302118845');

        expect(bodyOf(taxIdentityResponseSchema, res)).toMatchObject({
          pan_document_removed: false,
          has_pan_document: true,
        });
        expect((await vendorRow(vendorId)).pan_document_url).toBe(key);
        expect(s3.log).toEqual([]);
        expect((await verifyByAdmin(vendorId)).status).toBe(200);
      });

      it('removes nothing when the new number is refused', async () => {
        const { vendorId, token } = await shop();
        await savePan(token, '302118845');
        await uploaded(token);
        const [key] = documentsOf(vendorId);
        s3.log.length = 0;

        const res = await savePan(token, '60987123');

        expect(res.status).toBe(400);
        expect((await vendorRow(vendorId)).pan_document_url).toBe(key);
        expect(s3.log).toEqual([]);
      });

      it('stands when the bucket cannot delete the old document: the orphan is logged', async () => {
        const { vendorId, token } = await shop();
        await savePan(token, '302118845');
        await uploaded(token);
        const [oldKey] = documentsOf(vendorId);
        s3.failing.add('DeleteObject');

        const res = await savePan(token, '609871234');

        expect(res.status).toBe(200);
        // The row no longer names it, so no admin can be shown the old certificate.
        expect((await vendorRow(vendorId)).pan_document_url).toBeNull();
        expect(documentsOf(vendorId)).toEqual([oldKey]);
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(warnings.mock.calls[0]?.[0]))).toMatchObject({
          storage: 'orphan_object',
          kind: 'pan_document',
          key: oldKey,
        });
      });

      it('leaves one consistent outcome when a PAN change races an upload', async () => {
        for (let round = 0; round < 4; round += 1) {
          const { vendorId, token } = await shop();
          await savePan(token, '302118845');
          await uploaded(token);

          const [change, second] = await Promise.all([
            savePan(token, '609871234'),
            upload(token, [{ bytes: jpeg }]),
          ]);

          expect(change.status).toBe(200);
          expect(second.status).toBe(201);
          // Whichever committed second decided; the bucket holds exactly what the row names.
          const key = (await vendorRow(vendorId)).pan_document_url;
          expect(documentsOf(vendorId)).toEqual(key === null ? [] : [key]);
        }
      });
    });

    describe('GET /api/vendor/tax-identity', () => {
      it('says what is on file, and whether a document is, without saying where', async () => {
        const { vendorId, token } = await shop();
        const read = () =>
          request(cloud.app).get('/api/vendor/tax-identity').set('authorization', token);

        const before = await read();
        await uploaded(token);
        const after = await read();

        expect(before.status).toBe(200);
        expect(before.headers['cache-control']).toBe('no-store');
        expect(bodyOf(taxIdentityViewSchema, before)).toEqual({
          vendor_id: vendorId,
          tax_id: null,
          is_vat_registered: false,
          legal_name: null,
          registered_address: null,
          status: 'LIVE',
          pan_verified_at: null,
          has_pan_document: false,
        });
        expect(bodyOf(taxIdentityViewSchema, after).has_pan_document).toBe(true);
        expect(JSON.stringify(after.body)).not.toContain('kyc/');
      });

      it('is the vendor’s own (401 / 403 / 404)', async () => {
        const read = (token: string | null) => {
          const req = request(cloud.app).get('/api/vendor/tax-identity');
          return token === null ? req : req.set('authorization', token);
        };

        expect((await read(null)).status).toBe(401);
        expect((await read(adminToken)).status).toBe(403);
        expect((await read(bearer(await createUser(db, 'VENDOR'), 'VENDOR'))).status).toBe(404);
      });
    });

    describe('GET /api/admin/vendors/:id/pan-document', () => {
      const read = (vendorId: string, token: string | null = adminToken) => {
        const req = request(cloud.app).get(`/api/admin/vendors/${vendorId}/pan-document`);
        return (token === null ? req : req.set('authorization', token))
          .buffer(true)
          .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              done(null, Buffer.concat(chunks));
            });
          });
      };

      it('streams the stored document to a Super Admin, never to be cached', async () => {
        const { vendorId, token } = await shop();
        await uploaded(token);
        const stored = s3.objects.get(
          `${PRIVATE}/${(await vendorRow(vendorId)).pan_document_url ?? ''}`,
        );

        const res = await read(vendorId);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/webp');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.body).toEqual(stored?.body);
      });

      it('shows the document that replaced an earlier one', async () => {
        const { vendorId, token } = await shop();
        await uploaded(token);
        await uploaded(token, await photo({ width: 500, height: 100 }));

        const res = await read(vendorId);

        expect(await describeImage(res.body as Buffer)).toMatchObject({ width: 500, height: 100 });
      });

      it('answers 404 for a vendor without a document, an unknown vendor and a lost object', async () => {
        const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const none = await shop();
        const lost = await shop();
        await uploaded(lost.token);
        s3.objects.delete(`${PRIVATE}/${(await vendorRow(lost.vendorId)).pan_document_url ?? ''}`);

        const noDocument = await request(cloud.app)
          .get(`/api/admin/vendors/${none.vendorId}/pan-document`)
          .set('authorization', adminToken);
        const unknown = await request(cloud.app)
          .get(`/api/admin/vendors/${adminId}/pan-document`)
          .set('authorization', adminToken);
        const lostObject = await request(cloud.app)
          .get(`/api/admin/vendors/${lost.vendorId}/pan-document`)
          .set('authorization', adminToken);
        const badId = await request(cloud.app)
          .get('/api/admin/vendors/not-a-uuid/pan-document')
          .set('authorization', adminToken);

        expect(noDocument.status).toBe(404);
        expect(errorOf(noDocument).code).toBe('PAN_DOCUMENT_NOT_FOUND');
        expect(unknown.status).toBe(404);
        expect(errorOf(unknown).code).toBe('VENDOR_NOT_FOUND');
        expect(lostObject.status).toBe(404);
        expect(errorOf(lostObject).code).toBe('PAN_DOCUMENT_NOT_FOUND');
        expect(badId.status).toBe(400);
        errors.mockRestore();
      });

      it('is closed to everyone else, the vendor included', async () => {
        const { vendorId, token } = await shop();
        await uploaded(token);

        expect((await read(vendorId, null)).status).toBe(401);
        expect((await read(vendorId, token)).status).toBe(403);
        expect((await read(vendorId, bearer(await createUser(db), 'CUSTOMER'))).status).toBe(403);
      });

      it('the compliance list says which vendors have uploaded one', async () => {
        const withDocument = await shop();
        const without = await shop();
        await uploaded(withDocument.token);

        const res = await request(cloud.app)
          .get('/api/admin/compliance/vendors')
          .set('authorization', adminToken);

        const listed = bodyOf(adminComplianceVendorListResponseSchema, res).vendors;
        expect(listed.find((vendor) => vendor.id === withDocument.vendorId)?.has_pan_document).toBe(
          true,
        );
        expect(listed.find((vendor) => vendor.id === without.vendorId)?.has_pan_document).toBe(
          false,
        );
        expect(JSON.stringify(res.body)).not.toContain('kyc/');
      });
    });

    describe('on the local disk (development)', () => {
      it('keeps the document outside the directory the API serves', async () => {
        const { vendorId, token } = await shop();

        const res = await upload(token, [{ bytes: jpeg }], local);

        expect(res.status).toBe(201);
        const key = (await vendorRow(vendorId)).pan_document_url ?? '';
        const [name] = await readdir(join(TEST_PRIVATE_UPLOADS_DIR, 'kyc', 'pan', vendorId));
        expect(key.endsWith(`/${name ?? ''}`)).toBe(true);
        expect((await request(local.app).get(`/uploads/${key}`)).status).toBe(404);
        expect((await request(local.app).get(`/${key}`)).status).toBe(404);
        const viaApi = await request(local.app)
          .get(`/api/admin/vendors/${vendorId}/pan-document`)
          .set('authorization', adminToken);
        expect(viaApi.status).toBe(200);
      });

      it('deletes the replaced file from the disk', async () => {
        const { vendorId, token } = await shop();
        await upload(token, [{ bytes: jpeg }], local);
        const directory = join(TEST_PRIVATE_UPLOADS_DIR, 'kyc', 'pan', vendorId);
        const [first] = await readdir(directory);

        await upload(token, [{ bytes: jpeg }], local);

        const files = await readdir(directory);
        expect(files).toHaveLength(1);
        expect(files[0]).not.toBe(first);
      });
    });
  });

  // ------------------------------------------------------------------------------------------
  describe('the existing uploads on the bucket', () => {
    it('product photos go to the public bucket, and a dropped photo is deleted from it', async () => {
      const { vendorId, token } = await shop();
      const categoryId = await createCategory(db);
      const productId = await createProduct(db, vendorId, 1, 100, { category_id: categoryId });

      const res = await multipart(cloud, `/api/vendor/products/${productId}/images`, token, [
        { bytes: jpeg, field: 'images' },
        { bytes: await photo({ format: 'png' }), field: 'images' },
      ]);
      expect(res.status).toBe(201);
      const [first, second] = bodyOf(vendorProductResponseSchema, res).product.image_urls;
      expect(first).toMatch(
        new RegExp(`^${CDN}/product-images/${productId}/[0-9a-f-]{36}\\.webp$`),
      );
      expect(publicObject(first ?? '')?.contentType).toBe('image/webp');
      s3.log.length = 0;

      const put = await request(cloud.app)
        .put(`/api/vendor/products/${productId}`)
        .set('authorization', token)
        .send({ category_id: categoryId, name: 'Tea', price_npr: 100, image_urls: [second] });

      expect(put.status).toBe(200);
      expect(publicObject(first ?? '')).toBeUndefined();
      expect(publicObject(second ?? '')).toBeDefined();
      expect(deletes()).toEqual([
        { operation: 'DeleteObject', bucket: PUBLIC, key: keyOfUrl(first ?? '') },
      ]);
    });

    it('a refused product upload leaves no object behind', async () => {
      const { vendorId, token } = await shop();
      const productId = await createProduct(db, vendorId, 1);
      const before = s3.keys(PUBLIC);

      const res = await multipart(cloud, `/api/vendor/products/${productId}/images`, token, [
        { bytes: jpeg, field: 'images' },
        { bytes: Buffer.from('<svg/>'), field: 'images' },
      ]);

      expect(res.status).toBe(415);
      expect(s3.keys(PUBLIC)).toEqual(before);
    });

    it('dispute evidence goes to the public bucket; the API itself serves no file', async () => {
      const customerId = await createUser(db);
      const order = await createOrder(db, { vendorId: await createVendor(db), customerId });
      await markDelivered(db, order.id);
      await db
        .update(orders)
        .set({ delivered_at: sql`now()` })
        .where(eq(orders.id, order.id));

      const res = await request(cloud.app)
        .post('/api/uploads/dispute-evidence')
        .set('authorization', bearer(customerId))
        .field('order_id', order.id)
        .attach('file', jpeg, { filename: 'jar.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      const { url, content_type: contentType } = bodyOf(disputeEvidenceUploadResponseSchema, res);
      expect(contentType).toBe('image/webp');
      expect(url).toMatch(new RegExp(`^${CDN}/dispute-evidence/${order.id}/[0-9a-f-]{36}\\.webp$`));
      expect(publicObject(url)).toBeDefined();
      expect(cloud.container.evidence.isEvidenceUrl(order.id, url)).toBe(true);
      expect((await request(cloud.app).get(`/uploads/${keyOfUrl(url)}`)).status).toBe(404);
    });
  });
});

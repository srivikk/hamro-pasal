import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { orders } from '@hamro-pasal/db';
import {
  disputeEvidenceUploadResponseSchema,
  MAX_DISPUTE_EVIDENCE_BYTES,
} from '@hamro-pasal/shared-types';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';

import { createOrder, createUser, createVendor, markDelivered } from './support/fixtures';
import { describeImage, noisyJpeg, paddedTo, photo } from './support/images';
import {
  bearer,
  bodyOf,
  buildTestApp,
  errorOf,
  TEST_UPLOADS_BASE_URL,
  TEST_UPLOADS_DIR,
  type TestApp,
} from './support/http';

let baseJpeg: Buffer;

/** A real JPEG, padded after its end up to `size` bytes (a smaller size gives the image itself). */
function jpegOfSize(size: number): Buffer {
  return paddedTo(baseJpeg, size);
}

/**
 * Phase 9: POST /api/uploads/dispute-evidence (local stand-in for Cloudflare R2). Files land in a
 * temporary directory and are served back under /uploads.
 */
describe('dispute evidence uploads', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = buildTestApp();
    baseJpeg = await photo();
  });

  afterAll(async () => {
    await t.container.close();
    await rm(TEST_UPLOADS_DIR, { recursive: true, force: true });
  });

  const db = () => t.container.db;

  async function deliveredOrder(hoursAgo = 1) {
    const customerId = await createUser(db());
    const vendorId = await createVendor(db());
    const order = await createOrder(db(), { vendorId, customerId });
    await markDelivered(db(), order.id);
    await db()
      .update(orders)
      .set({ delivered_at: sql`now() - make_interval(secs => ${hoursAgo * 3600}::float8)` })
      .where(eq(orders.id, order.id));
    return { customerId, orderId: order.id };
  }

  function upload(
    customerId: string | null,
    fields: Record<string, string>,
    file?: { bytes: Buffer; name?: string; type?: string },
  ) {
    let req = request(t.app).post('/api/uploads/dispute-evidence');
    if (customerId !== null) req = req.set('authorization', bearer(customerId));
    for (const [name, value] of Object.entries(fields)) req = req.field(name, value);
    if (file !== undefined) {
      req = req.attach('file', file.bytes, {
        filename: file.name ?? 'evidence.jpg',
        contentType: file.type ?? 'image/jpeg',
      });
    }
    return req;
  }

  async function storedFiles(orderId: string): Promise<string[]> {
    try {
      return await readdir(join(TEST_UPLOADS_DIR, 'dispute-evidence', orderId));
    } catch {
      return [];
    }
  }

  it('stores an image for a delivered order and serves it back', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const bytes = jpegOfSize(2048);

    const res = await upload(customerId, { order_id: orderId }, { bytes });

    expect(res.status).toBe(201);
    const body = bodyOf(disputeEvidenceUploadResponseSchema, res);
    // Stored as WebP whatever was sent (SPEC infrastructure §6).
    expect(body.content_type).toBe('image/webp');
    expect(body.url).toMatch(
      new RegExp(`^${TEST_UPLOADS_BASE_URL}/dispute-evidence/${orderId}/[0-9a-f-]{36}\\.webp$`),
    );
    expect(t.container.evidence.isEvidenceUrl(orderId, body.url)).toBe(true);

    const served = await request(t.app).get(new URL(body.url).pathname);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(await describeImage(Buffer.from(served.body as Buffer))).toMatchObject({
      format: 'webp',
      width: 64,
      height: 48,
    });
  });

  it('stores a large photo at 1200 px at most and under 300 KB', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const bytes = await noisyJpeg();
    expect(bytes.length).toBeGreaterThan(1024 * 1024);

    const res = await upload(customerId, { order_id: orderId }, { bytes });

    expect(res.status).toBe(201);
    const { url } = bodyOf(disputeEvidenceUploadResponseSchema, res);
    const served = await request(t.app).get(new URL(url).pathname);
    const stored = await describeImage(Buffer.from(served.body as Buffer));
    expect(stored).toMatchObject({ format: 'webp', width: 1200, height: 900 });
    expect(stored.bytes).toBeLessThan(300 * 1024);
  });

  it('refuses a file that only carries an image signature (415), storing nothing', async () => {
    const { customerId, orderId } = await deliveredOrder();
    const fake = Buffer.alloc(2048, 0x20);
    Buffer.from([0xff, 0xd8, 0xff]).copy(fake);

    const res = await upload(customerId, { order_id: orderId }, { bytes: fake });

    expect(res.status).toBe(415);
    expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await storedFiles(orderId)).toEqual([]);
  });

  it('accepts exactly 5 MB and rejects anything larger (413), storing nothing', async () => {
    const { customerId, orderId } = await deliveredOrder();

    const atLimit = await upload(
      customerId,
      { order_id: orderId },
      { bytes: jpegOfSize(MAX_DISPUTE_EVIDENCE_BYTES) },
    );
    const over = await upload(
      customerId,
      { order_id: orderId },
      { bytes: jpegOfSize(5 * 1024 * 1024 + 1) },
    );

    expect(atLimit.status).toBe(201);
    expect(over.status).toBe(413);
    expect(errorOf(over)).toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { max_bytes: 5 * 1024 * 1024 },
    });
    expect(await storedFiles(orderId)).toHaveLength(1);
  });

  it('checks the bytes, not the declared type (415)', async () => {
    const { customerId, orderId } = await deliveredOrder();

    const res = await upload(
      customerId,
      { order_id: orderId },
      { bytes: Buffer.from('%PDF-1.7 not an image'), name: 'photo.jpg', type: 'image/jpeg' },
    );

    expect(res.status).toBe(415);
    expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await storedFiles(orderId)).toEqual([]);
  });

  it('requires the order id and a file (400)', async () => {
    const { customerId, orderId } = await deliveredOrder();

    const noFile = await upload(customerId, { order_id: orderId });
    const noOrder = await upload(customerId, {}, { bytes: jpegOfSize(100) });
    const extraField = await upload(
      customerId,
      { order_id: orderId, user_id: customerId },
      { bytes: jpegOfSize(100) },
    );

    for (const res of [noFile, noOrder, extraField]) {
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    }
  });

  it("answers 404 for another customer's order", async () => {
    const { orderId } = await deliveredOrder();
    const stranger = await createUser(db());

    const res = await upload(stranger, { order_id: orderId }, { bytes: jpegOfSize(100) });

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('ORDER_NOT_FOUND');
    expect(await storedFiles(orderId)).toEqual([]);
  });

  it('refuses orders outside the 48 h dispute window (422)', async () => {
    const late = await deliveredOrder(48.1);
    const customerId = await createUser(db());
    const vendorId = await createVendor(db());
    const undelivered = await createOrder(db(), { vendorId, customerId });

    const afterWindow = await upload(
      late.customerId,
      { order_id: late.orderId },
      { bytes: jpegOfSize(100) },
    );
    const beforeDelivery = await upload(
      customerId,
      { order_id: undelivered.id },
      { bytes: jpegOfSize(100) },
    );

    expect(afterWindow.status).toBe(422);
    expect(errorOf(afterWindow).code).toBe('DISPUTE_WINDOW_CLOSED');
    expect(beforeDelivery.status).toBe(422);
    expect(errorOf(beforeDelivery).code).toBe('DISPUTE_WINDOW_CLOSED');
  });

  it('needs a customer access token', async () => {
    const { orderId } = await deliveredOrder();

    const res = await upload(null, { order_id: orderId }, { bytes: jpegOfSize(100) });

    expect(res.status).toBe(401);
    expect(await storedFiles(orderId)).toEqual([]);
  });
});

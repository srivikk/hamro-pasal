import { vendorSchema } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { createDatabase, type Database } from '../src/client';
import { homePromotions, vendors } from '../src/schema';
import { resolveTestDatabaseUrl } from '../src/testing';
import { createTestPool, createUser, createVendor, firstRow, pgError } from './support/fixtures';

const CHECK_VIOLATION = '23514';
const INVALID_ENUM_VALUE = '22P02';
const FOREIGN_KEY_VIOLATION = '23503';

describe('migration 0025: settlement model and home promotions', () => {
  let pool: Pool;
  let db: Database;
  let adminId: string;

  beforeAll(async () => {
    pool = createTestPool();
    db = createDatabase(process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl());
    adminId = await createUser(pool, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await db.$client.end();
    await pool.end();
  });

  describe('vendors.settlement_model', () => {
    it('makes every shop Model B (PLATFORM_ESCROW) unless told otherwise, and matches the contract', async () => {
      const vendorId = await createVendor(pool);
      const row = firstRow(await db.select().from(vendors).where(eq(vendors.id, vendorId)));

      expect(row.settlement_model).toBe('PLATFORM_ESCROW');
      expect(vendorSchema.parse(row)).toEqual(row);
    });

    it('takes the three models of SPEC and nothing else', async () => {
      const vendorId = await createVendor(pool);
      const set = (model: string) =>
        pool.query('UPDATE vendors SET settlement_model = $2 WHERE id = $1', [vendorId, model]);

      for (const model of ['COD_CREDIT', 'DIRECT_PREPAID', 'PLATFORM_ESCROW']) {
        await expect(set(model)).resolves.toBeDefined();
      }
      expect((await pgError(set('ESCROW'))).code).toBe(INVALID_ENUM_VALUE);
      expect(
        (
          await pgError(
            pool.query('UPDATE vendors SET settlement_model = NULL WHERE id = $1', [vendorId]),
          )
        ).code,
      ).toBe('23502');
    });
  });

  describe('home_promotions', () => {
    const promotion = (overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        placement: 'CAROUSEL',
        image_url: 'https://cdn.hamropasal.test/promotions/dashain.webp',
        title: 'Dashain offers are here',
        subtitle: null,
        target_type: 'CATEGORY',
        target_value: 'festive',
        created_by_user_id: adminId,
        ...overrides,
      };
      const names = Object.keys(row);
      return pool.query<{ id: string }>(
        `INSERT INTO home_promotions (${names.join(', ')})
         VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
    };

    const promotionRow = async (id: string) =>
      firstRow(await db.select().from(homePromotions).where(eq(homePromotions.id, id)));

    it('stores a promotion: active, first in order, not sponsored', async () => {
      const row = await promotionRow(firstRow((await promotion()).rows).id);
      expect(row).toMatchObject({
        placement: 'CAROUSEL',
        target_type: 'CATEGORY',
        target_value: 'festive',
        display_order: 0,
        is_active: true,
        starts_at: null,
        ends_at: null,
        is_sponsored: false,
        ad_purchase_id: null,
        created_by_user_id: adminId,
      });
    });

    it('needs an image for a banner and a title for an offer tile', async () => {
      expect((await pgError(promotion({ image_url: null }))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(promotion({ placement: 'FEATURED', title: null }))).code).toBe(
        CHECK_VIOLATION,
      );
      // A tile without artwork and a banner without text are both fine.
      await expect(promotion({ placement: 'FEATURED', image_url: null })).resolves.toBeDefined();
      await expect(promotion({ title: null })).resolves.toBeDefined();
      for (const overrides of [{ title: '  ' }, { subtitle: '' }, { display_order: -1 }]) {
        expect((await pgError(promotion(overrides))).code).toBe(CHECK_VIOLATION);
      }
    });

    it('has a target type and a value together, or neither', async () => {
      await expect(promotion({ target_type: null, target_value: null })).resolves.toBeDefined();
      for (const overrides of [
        { target_value: null },
        { target_type: null },
        { target_value: '   ' },
      ]) {
        expect((await pgError(promotion(overrides))).code).toBe(CHECK_VIOLATION);
      }
      expect((await pgError(promotion({ target_type: 'PRODUCT' }))).code).toBe(INVALID_ENUM_VALUE);
      expect((await pgError(promotion({ placement: 'POPUP' }))).code).toBe(INVALID_ENUM_VALUE);
    });

    it('ends after it starts', async () => {
      await expect(
        promotion({ starts_at: '2026-10-10T00:00:00+05:45', ends_at: '2026-10-25T23:59:59+05:45' }),
      ).resolves.toBeDefined();
      expect(
        (
          await pgError(
            promotion({
              starts_at: '2026-10-25T00:00:00+05:45',
              ends_at: '2026-10-25T00:00:00+05:45',
            }),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
    });

    it('cannot be sponsored without an ad purchase that exists (the foreign key of 0026)', async () => {
      const purchaseId = '11111111-1111-4111-8111-111111111111';
      // Sponsored and a purchase go together, whether or not the purchase exists.
      for (const overrides of [{ is_sponsored: true }, { ad_purchase_id: purchaseId }]) {
        expect((await pgError(promotion(overrides))).code).toBe(CHECK_VIOLATION);
      }
      expect(
        (await pgError(promotion({ is_sponsored: true, ad_purchase_id: purchaseId }))).code,
      ).toBe(FOREIGN_KEY_VIOLATION);
      const id = firstRow((await promotion()).rows).id;
      expect(
        (
          await pgError(
            pool.query(
              'UPDATE home_promotions SET is_sponsored = true, ad_purchase_id = $2 WHERE id = $1',
              [id, purchaseId],
            ),
          )
        ).code,
      ).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('names its author, who cannot be deleted from under it, and stamps updated_at', async () => {
      expect(
        (await pgError(promotion({ created_by_user_id: '11111111-1111-4111-8111-111111111111' })))
          .code,
      ).toBe(FOREIGN_KEY_VIOLATION);
      const authorId = await createUser(pool, 'SUPER_ADMIN');
      const id = firstRow((await promotion({ created_by_user_id: authorId })).rows).id;
      expect((await pgError(pool.query('DELETE FROM users WHERE id = $1', [authorId]))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );

      const before = await promotionRow(id);
      await pool.query('SELECT pg_sleep(0.02)');
      await pool.query('UPDATE home_promotions SET is_active = false WHERE id = $1', [id]);
      const after = await promotionRow(id);
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });
  });
});

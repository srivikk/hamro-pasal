import type { Pool } from 'pg';

import { createTestPool, createUser, createVendor, firstRow, pgError } from './support/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** What the hand-written triggers raise. */
const INTEGRITY_VIOLATION = '23000';

describe('migration 0026: settlement model change requests and ad purchases', () => {
  let pool: Pool;
  let adminId: string;

  beforeAll(async () => {
    pool = createTestPool();
    adminId = await createUser(pool, 'SUPER_ADMIN');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function shop() {
    const vendorId = await createVendor(pool);
    const { rows } = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM vendors WHERE id = $1',
      [vendorId],
    );
    return { vendorId, userId: firstRow(rows).user_id };
  }

  const request = (vendorId: string, userId: string, to = 'COD_CREDIT', from = 'PLATFORM_ESCROW') =>
    pool.query<{ id: string; status: string }>(
      `INSERT INTO settlement_model_change_requests
         (vendor_id, from_model, requested_model, requested_by_user_id)
       VALUES ($1, $2, $3, $4) RETURNING id, status`,
      [vendorId, from, to, userId],
    );

  describe('settlement_model_change_requests', () => {
    it("stores a PENDING request made by the shop's own account", async () => {
      const { vendorId, userId } = await shop();
      expect(firstRow((await request(vendorId, userId)).rows).status).toBe('PENDING');
    });

    it('refuses a request filed by anyone else: an admin, or another shop', async () => {
      const { vendorId } = await shop();
      const other = await shop();
      expect((await pgError(request(vendorId, adminId))).code).toBe(INTEGRITY_VIOLATION);
      expect((await pgError(request(vendorId, other.userId))).code).toBe(INTEGRITY_VIOLATION);
    });

    it('keeps one PENDING request per shop, and allows another once it is decided', async () => {
      const { vendorId, userId } = await shop();
      const id = firstRow((await request(vendorId, userId)).rows).id;
      expect((await pgError(request(vendorId, userId))).code).toBe(UNIQUE_VIOLATION);

      await pool.query(
        `UPDATE settlement_model_change_requests
           SET status = 'REJECTED', decided_at = now(), decided_by_user_id = $2 WHERE id = $1`,
        [id, adminId],
      );
      await expect(request(vendorId, userId)).resolves.toBeDefined();
    });

    it('asks for a different model', async () => {
      const { vendorId, userId } = await shop();
      expect(
        (await pgError(request(vendorId, userId, 'PLATFORM_ESCROW', 'PLATFORM_ESCROW'))).code,
      ).toBe(CHECK_VIOLATION);
    });

    it('ties the decision to its time and its admin, and a reason to a rejection', async () => {
      const { vendorId, userId } = await shop();
      const id = firstRow((await request(vendorId, userId)).rows).id;
      const update = (set: string) =>
        pool.query(`UPDATE settlement_model_change_requests SET ${set} WHERE id = $1`, [id]);

      // Decided without a time or an admin; a time without an admin; a reason while pending.
      expect((await pgError(update(`status = 'APPROVED'`))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(update(`status = 'APPROVED', decided_at = now()`))).code).toBe(
        CHECK_VIOLATION,
      );
      expect((await pgError(update(`rejection_reason = 'No'`))).code).toBe(CHECK_VIOLATION);
      expect(
        (
          await pgError(
            update(
              `status = 'APPROVED', decided_at = now(), decided_by_user_id = '${adminId}', rejection_reason = 'No'`,
            ),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
      await expect(
        update(
          `status = 'REJECTED', decided_at = now(), decided_by_user_id = '${adminId}', rejection_reason = 'Dues outstanding'`,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('ad_purchases', () => {
    async function product(billing = 'FLAT_RATE') {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO ad_products (name, slot, billing_model, price_npr, duration_days, created_by_user_id)
         VALUES ('Carousel', 'CAROUSEL', $1, 5000, 7, $2) RETURNING id`,
        [billing, adminId],
      );
      return firstRow(rows).id;
    }

    const purchase = (
      vendorId: string,
      userId: string,
      productId: string,
      overrides: Record<string, unknown> = {},
    ) => {
      const row = {
        vendor_id: vendorId,
        ad_product_id: productId,
        billing_model: 'FLAT_RATE',
        price_npr: 5000,
        budget_npr: null,
        settlement_model: 'PLATFORM_ESCROW',
        starts_at: '2026-10-10T00:00:00Z',
        ends_at: '2026-10-17T00:00:00Z',
        agreed_by_user_id: userId,
        idempotency_key: `key-${Math.random().toString(36).slice(2)}-0000`,
        ...overrides,
      };
      const columns = Object.keys(row);
      return pool.query<{ id: string; status: string; amount_paid_npr: string }>(
        `INSERT INTO ad_purchases (${columns.join(', ')})
         VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})
         RETURNING id, status, amount_paid_npr`,
        Object.values(row),
      );
    };

    it("stores an ACTIVE purchase agreed by the shop's own account, with nothing paid yet", async () => {
      const { vendorId, userId } = await shop();
      const row = firstRow((await purchase(vendorId, userId, await product())).rows);
      expect(row.status).toBe('ACTIVE');
      expect(Number(row.amount_paid_npr)).toBe(0);
    });

    it('refuses a purchase an admin or another shop agreed to: no unilateral billing', async () => {
      const { vendorId } = await shop();
      const other = await shop();
      const productId = await product();
      expect((await pgError(purchase(vendorId, adminId, productId))).code).toBe(
        INTEGRITY_VIOLATION,
      );
      expect((await pgError(purchase(vendorId, other.userId, productId))).code).toBe(
        INTEGRITY_VIOLATION,
      );
    });

    it('needs a budget exactly for a per-order ad, dates in order and a real product', async () => {
      const { vendorId, userId } = await shop();
      const productId = await product();
      for (const overrides of [
        { budget_npr: 9000 },
        { billing_model: 'PER_ORDER_PREMIUM' },
        { billing_model: 'PER_ORDER_PREMIUM', budget_npr: 10 },
        { ends_at: '2026-10-09T00:00:00Z' },
        { amount_paid_npr: -1 },
      ]) {
        expect((await pgError(purchase(vendorId, userId, productId, overrides))).code).toBe(
          CHECK_VIOLATION,
        );
      }
      expect(
        (await pgError(purchase(vendorId, userId, '11111111-1111-4111-8111-111111111111'))).code,
      ).toBe(FOREIGN_KEY_VIOLATION);
      await expect(
        purchase(vendorId, userId, productId, {
          billing_model: 'PER_ORDER_PREMIUM',
          budget_npr: 20000,
        }),
      ).resolves.toBeDefined();
    });

    it('buys once per idempotency key', async () => {
      const { vendorId, userId } = await shop();
      const productId = await product();
      await purchase(vendorId, userId, productId, { idempotency_key: 'same-key-0001' });
      expect(
        (await pgError(purchase(vendorId, userId, productId, { idempotency_key: 'same-key-0001' })))
          .code,
      ).toBe(UNIQUE_VIOLATION);
    });

    it('lets the status and the amount paid move, and never the terms agreed', async () => {
      const { vendorId, userId } = await shop();
      const id = firstRow((await purchase(vendorId, userId, await product())).rows).id;
      const update = (set: string) =>
        pool.query(`UPDATE ad_purchases SET ${set} WHERE id = $1`, [id]);

      await expect(update(`status = 'ENDED', amount_paid_npr = 5000`)).resolves.toBeDefined();
      for (const set of [
        'price_npr = 1',
        `billing_model = 'PER_ORDER_PREMIUM', budget_npr = 9000`,
        `settlement_model = 'COD_CREDIT'`,
        `agreed_by_user_id = '${adminId}'`,
      ]) {
        expect((await pgError(update(set))).code).toBe(INTEGRITY_VIOLATION);
      }
    });

    it('is what makes a promotion sponsored, and cannot be deleted from under one', async () => {
      const { vendorId, userId } = await shop();
      const id = firstRow((await purchase(vendorId, userId, await product())).rows).id;
      await expect(
        pool.query(
          `INSERT INTO home_promotions
             (placement, image_url, target_type, target_value, is_sponsored, ad_purchase_id, created_by_user_id)
           VALUES ('CAROUSEL', 'https://cdn.example/a.webp', 'SHOP', $1, true, $2, $3)`,
          [vendorId, id, adminId],
        ),
      ).resolves.toBeDefined();
      expect((await pgError(pool.query('DELETE FROM ad_purchases WHERE id = $1', [id]))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });
  });
});

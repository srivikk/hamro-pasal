import type { Pool } from 'pg';

import {
  createOrder,
  createTestPool,
  createUser,
  createVendor,
  firstRow,
  pgError,
} from './support/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** What the hand-written triggers raise. */
const INTEGRITY_VIOLATION = '23000';

describe('migrations 0033 and 0034: the invoice access log and vendor offers', () => {
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

  describe('invoice_access_log', () => {
    /** A sealed invoice of a new shop. */
    async function invoice() {
      const { vendorId, userId } = await shop();
      const customerId = await createUser(pool);
      const orderId = await createOrder(pool, { vendorId, customerId });
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO invoices
           (vendor_id, order_id, customer_id, fiscal_year, bill_number, invoice_sequence, issued_at,
            issued_date_bs, subtotal_npr, discount_npr, delivery_charge_npr, grand_total_npr,
            seller_name, seller_address, seller_phone, seller_tax_id, seller_is_vat_registered,
            buyer_name, payment_method, taxable_amount_npr, vat_rate_percent, vat_amount_npr,
            exempt_amount_npr, delivery_charged_by, amount_in_words, line_items)
         VALUES ($1, $2, $3, '2082/083', 1, 'HP-2082-000001', now(), '2082-06-22', 1000, 0, 50,
                 1050, 'Shop', 'Thamel', '+9779800000011', '302118845', false, 'Customer', 'COD',
                 0, 0, 0, 1050, 'VENDOR', 'Rupees One Thousand Fifty Only', '[{"line_number":1}]')
         RETURNING id`,
        [vendorId, orderId, customerId],
      );
      return { invoiceId: firstRow(rows).id, userId };
    }

    const log = (
      invoiceId: string,
      userId: string,
      action: string,
      copyNumber: number | null,
      role = 'VENDOR',
    ) =>
      pool.query<{ id: string; occurred_at: Date }>(
        `INSERT INTO invoice_access_log (invoice_id, user_id, actor_role, action, copy_number)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, occurred_at`,
        [invoiceId, userId, role, action, copyNumber],
      );

    it('stores a view, a download and numbered prints with the database clock', async () => {
      const { invoiceId, userId } = await invoice();

      const before = Date.now() - 5_000;
      const view = firstRow((await log(invoiceId, userId, 'VIEW', null)).rows);
      await log(invoiceId, adminId, 'DOWNLOAD', null, 'SUPER_ADMIN');
      await log(invoiceId, userId, 'PRINT', 0);
      await log(invoiceId, userId, 'PRINT', 1);

      expect(view.occurred_at.getTime()).toBeGreaterThan(before);
      const { rows } = await pool.query<{ action: string; copy_number: number | null }>(
        `SELECT action, copy_number FROM invoice_access_log WHERE invoice_id = $1
         ORDER BY occurred_at`,
        [invoiceId],
      );
      expect(rows).toEqual([
        { action: 'VIEW', copy_number: null },
        { action: 'DOWNLOAD', copy_number: null },
        { action: 'PRINT', copy_number: 0 },
        { action: 'PRINT', copy_number: 1 },
      ]);
    });

    it('gives an invoice each copy number once', async () => {
      const { invoiceId, userId } = await invoice();
      const other = await invoice();
      await log(invoiceId, userId, 'PRINT', 0);

      const error = await pgError(log(invoiceId, userId, 'PRINT', 0));
      expect(error.code).toBe(UNIQUE_VIOLATION);
      expect(error.constraint).toBe('invoice_access_log_copy_number_uidx');
      // Another invoice has its own original.
      await expect(log(other.invoiceId, other.userId, 'PRINT', 0)).resolves.toBeDefined();
    });

    it('needs a copy number exactly for a print, never a negative one, and a known action', async () => {
      const { invoiceId, userId } = await invoice();

      for (const [action, copyNumber] of [
        ['PRINT', null],
        ['VIEW', 0],
        ['DOWNLOAD', 2],
        ['PRINT', -1],
      ] as const) {
        const error = await pgError(log(invoiceId, userId, action, copyNumber));
        expect(error.code).toBe(CHECK_VIOLATION);
        expect(error.constraint).toBe('invoice_access_log_copy_number_check');
      }
      const unknown = await pgError(log(invoiceId, userId, 'PRINTED', 0));
      expect(unknown.constraint).toBe('invoice_access_log_action_check');
    });

    it('names a real invoice and a real user', async () => {
      const { invoiceId, userId } = await invoice();
      const nobody = '00000000-0000-4000-8000-000000000000';

      expect((await pgError(log(nobody, userId, 'VIEW', null))).code).toBe(FOREIGN_KEY_VIOLATION);
      expect((await pgError(log(invoiceId, nobody, 'VIEW', null))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });

    it('is append-only: UPDATE, DELETE and TRUNCATE are refused', async () => {
      const { invoiceId, userId } = await invoice();
      const { id } = firstRow((await log(invoiceId, userId, 'PRINT', 0)).rows);

      for (const statement of [
        `UPDATE invoice_access_log SET copy_number = 5 WHERE id = '${id}'`,
        `UPDATE invoice_access_log SET occurred_at = now() WHERE id = '${id}'`,
        `DELETE FROM invoice_access_log WHERE id = '${id}'`,
        'TRUNCATE invoice_access_log',
      ]) {
        const error = await pgError(pool.query(statement));
        expect(error.code).toBe(INTEGRITY_VIOLATION);
        expect(error.message).toContain('append-only');
      }
      const { rows } = await pool.query<{ copy_number: number }>(
        'SELECT copy_number FROM invoice_access_log WHERE id = $1',
        [id],
      );
      expect(rows).toEqual([{ copy_number: 0 }]);
    });

    it('lets the sealed invoice be row-locked without being written', async () => {
      const { invoiceId } = await invoice();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rowCount } = await client.query(
          'SELECT id FROM invoices WHERE id = $1 FOR UPDATE',
          [invoiceId],
        );
        expect(rowCount).toBe(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('vendor_offers', () => {
    interface OfferColumns {
      kind?: string;
      value?: number;
      max?: number | null;
      minCart?: number;
      label?: string;
      endsAt?: string | null;
    }

    const offer = (vendorId: string, userId: string, columns: OfferColumns = {}) =>
      pool.query<{ id: string; starts_at: Date; ended_at: Date | null }>(
        `INSERT INTO vendor_offers
           (vendor_id, kind, value, max_discount_npr, min_cart_npr, label, ends_at, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, starts_at, ended_at`,
        [
          vendorId,
          columns.kind ?? 'PERCENTAGE',
          columns.value ?? 10,
          columns.max ?? null,
          columns.minCart ?? 0,
          columns.label ?? '10% OFF',
          columns.endsAt ?? null,
          userId,
        ],
      );

    const end = (id: string, userId: string) =>
      pool.query('UPDATE vendor_offers SET ended_at = now(), ended_by_user_id = $2 WHERE id = $1', [
        id,
        userId,
      ]);

    it("stores an offer created by the shop's own account, starting now and not ended", async () => {
      const { vendorId, userId } = await shop();

      const created = firstRow((await offer(vendorId, userId)).rows);
      const flat = await offer(vendorId, userId, {
        kind: 'FLAT',
        value: 100,
        minCart: 100,
        label: 'Flat Rs. 100 OFF',
      });

      expect(Math.abs(created.starts_at.getTime() - Date.now())).toBeLessThan(60_000);
      expect(created.ended_at).toBeNull();
      expect(flat.rowCount).toBe(1);
    });

    it('refuses an offer created by anyone else: an admin, or another shop', async () => {
      const { vendorId } = await shop();
      const other = await shop();

      for (const creator of [adminId, other.userId]) {
        const error = await pgError(offer(vendorId, creator));
        expect(error.code).toBe(INTEGRITY_VIOLATION);
        expect(error.message).toContain("vendor's own account");
      }
    });

    it('refuses an offer that is created already ended', async () => {
      const { vendorId, userId } = await shop();

      const error = await pgError(
        pool.query(
          `INSERT INTO vendor_offers
             (vendor_id, kind, value, label, created_by_user_id, ended_at, ended_by_user_id)
           VALUES ($1, 'PERCENTAGE', 10, '10% OFF', $2, now(), $2)`,
          [vendorId, userId],
        ),
      );
      expect(error.code).toBe(INTEGRITY_VIOLATION);
    });

    it.each<[string, OfferColumns, string]>([
      ['a value of zero', { value: 0 }, 'vendor_offers_value_check'],
      ['a percentage above 100', { value: 100.01 }, 'vendor_offers_value_check'],
      ['a cap of zero', { max: 0 }, 'vendor_offers_max_discount_check'],
      [
        'a cap on a flat discount',
        { kind: 'FLAT', value: 50, minCart: 500, max: 20 },
        'vendor_offers_max_discount_check',
      ],
      ['a negative minimum cart', { minCart: -1 }, 'vendor_offers_min_cart_check'],
      [
        'a flat discount above its minimum cart',
        { kind: 'FLAT', value: 100, minCart: 99.99 },
        'vendor_offers_flat_min_cart_check',
      ],
      ['a blank label', { label: '  ' }, 'vendor_offers_label_check'],
      ['an end before its start', { endsAt: '2020-01-01T00:00:00Z' }, 'vendor_offers_dates_check'],
    ])('refuses %s', async (_name, columns, constraint) => {
      const { vendorId, userId } = await shop();

      const error = await pgError(offer(vendorId, userId, columns));
      expect(error.code).toBe(CHECK_VIOLATION);
      expect(error.constraint).toBe(constraint);
    });

    it.each([
      ['kind', `kind = 'FLAT'`],
      ['value', 'value = 50'],
      ['min_cart_npr', 'min_cart_npr = 500'],
      ['max_discount_npr', 'max_discount_npr = 75'],
      ['starts_at', `starts_at = starts_at - interval '1 day'`],
      ['ends_at', `ends_at = now() + interval '1 hour'`],
      ['label', `label = '50% OFF'`],
      ['created_at', `created_at = created_at - interval '1 day'`],
    ])('never lets %s change once the offer exists', async (_column, assignment) => {
      const { vendorId, userId } = await shop();
      const { id } = firstRow(
        (await offer(vendorId, userId, { max: 100, endsAt: '2099-01-01T00:00:00Z' })).rows,
      );

      const error = await pgError(
        pool.query(`UPDATE vendor_offers SET ${assignment} WHERE id = $1`, [id]),
      );
      expect(error.code).toBe(INTEGRITY_VIOLATION);
      expect(error.message).toContain('never change');
    });

    it('refuses a term changed in the same statement that ends the offer', async () => {
      const { vendorId, userId } = await shop();
      const { id } = firstRow((await offer(vendorId, userId)).rows);

      const error = await pgError(
        pool.query(
          `UPDATE vendor_offers SET value = 90, ended_at = now(), ended_by_user_id = $2
           WHERE id = $1`,
          [id, userId],
        ),
      );
      expect(error.code).toBe(INTEGRITY_VIOLATION);
    });

    it('moves an offer to another shop for nobody', async () => {
      const { vendorId, userId } = await shop();
      const other = await shop();
      const { id } = firstRow((await offer(vendorId, userId)).rows);

      const error = await pgError(
        pool.query('UPDATE vendor_offers SET vendor_id = $2 WHERE id = $1', [id, other.vendorId]),
      );
      expect(error.code).toBe(INTEGRITY_VIOLATION);
    });

    it("is ended once, by the shop's own account, and stays ended", async () => {
      const { vendorId, userId } = await shop();
      const other = await shop();
      const { id } = firstRow((await offer(vendorId, userId)).rows);

      // Not by an admin or another shop, and not without naming who.
      expect((await pgError(end(id, adminId))).code).toBe(INTEGRITY_VIOLATION);
      expect((await pgError(end(id, other.userId))).code).toBe(INTEGRITY_VIOLATION);
      expect(
        (await pgError(pool.query('UPDATE vendor_offers SET ended_at = now() WHERE id = $1', [id])))
          .code,
      ).toBe(INTEGRITY_VIOLATION);

      expect((await end(id, userId)).rowCount).toBe(1);

      // Ended is final: not reopened, not ended again.
      const reopened = await pgError(
        pool.query(
          'UPDATE vendor_offers SET ended_at = NULL, ended_by_user_id = NULL WHERE id = $1',
          [id],
        ),
      );
      expect(reopened.code).toBe(INTEGRITY_VIOLATION);
      expect((await pgError(end(id, userId))).code).toBe(INTEGRITY_VIOLATION);
    });

    it('is never deleted, ended or not', async () => {
      const { vendorId, userId } = await shop();
      const live = firstRow((await offer(vendorId, userId)).rows).id;
      const ended = firstRow((await offer(vendorId, userId)).rows).id;
      await end(ended, userId);

      for (const id of [live, ended]) {
        const error = await pgError(pool.query('DELETE FROM vendor_offers WHERE id = $1', [id]));
        expect(error.code).toBe(INTEGRITY_VIOLATION);
      }
    });

    it('keeps a shop and an account that have offers', async () => {
      const { vendorId, userId } = await shop();
      await offer(vendorId, userId);

      expect(
        (await pgError(pool.query('DELETE FROM vendors WHERE id = $1', [vendorId]))).code,
      ).toBe(FOREIGN_KEY_VIOLATION);
    });
  });
});

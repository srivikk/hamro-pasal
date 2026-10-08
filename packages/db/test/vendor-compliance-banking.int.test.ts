import {
  platformSettingsSchema,
  vendorBankAccountSchema,
  vendorSchema,
} from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { createDatabase, type Database } from '../src/client';
import { platformSettings, vendorBankAccounts, vendors } from '../src/schema';
import { resolveTestDatabaseUrl } from '../src/testing';
import { createTestPool, createUser, createVendor, firstRow, pgError } from './support/fixtures';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

describe('migration 0022: compliance, delivery settings and banking', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    pool = createTestPool();
    db = createDatabase(process.env.TEST_DATABASE_URL ?? resolveTestDatabaseUrl());
  });

  afterAll(async () => {
    await db.$client.end();
    await pool.end();
  });

  const vendorRow = async (vendorId: string) =>
    firstRow(await db.select().from(vendors).where(eq(vendors.id, vendorId)));

  const setVendor = (vendorId: string, assignments: string, values: unknown[] = []) =>
    pool.query(`UPDATE vendors SET ${assignments} WHERE id = $1`, [vendorId, ...values]);

  describe('vendors', () => {
    it('gives a new shop its own Palika, no PAN, no charges, and matches the contract', async () => {
      const row = await vendorRow(await createVendor(pool));
      expect(vendorSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        serviceable_palikas: [row.municipality_palika_string],
        tax_id: null,
        is_vat_registered: false,
        legal_name: null,
        registered_address: null,
        pan_verified_at: null,
        pan_verified_by_user_id: null,
        status_before_compliance_suspension: null,
        delivery_fee_per_km_npr: 0,
        free_delivery_above_npr: null,
      });
    });

    it('always serves its own Palika, and at most 30', async () => {
      const vendorId = await createVendor(pool);
      const own = (await vendorRow(vendorId)).municipality_palika_string;

      await expect(
        setVendor(vendorId, 'serviceable_palikas = $2', [[own, 'Lalitpur Metropolitan City']]),
      ).resolves.toBeDefined();
      for (const list of [
        [],
        ['Lalitpur Metropolitan City'],
        [own, ...Array.from({ length: 30 }, (_, i) => `Palika ${String(i)}`)],
      ]) {
        expect((await pgError(setVendor(vendorId, 'serviceable_palikas = $2', [list]))).code).toBe(
          CHECK_VIOLATION,
        );
      }
    });

    it('takes a PAN of nine digits and non-blank names', async () => {
      const vendorId = await createVendor(pool);
      await expect(setVendor(vendorId, `tax_id = '302118845'`)).resolves.toBeDefined();
      for (const assignment of [
        `tax_id = '30211884'`,
        `tax_id = '30211884A'`,
        `legal_name = '  '`,
        `registered_address = ''`,
        'delivery_fee_per_km_npr = -1',
        'free_delivery_above_npr = 0',
      ]) {
        expect((await pgError(setVendor(vendorId, assignment))).code).toBe(CHECK_VIOLATION);
      }
    });

    it('can be SUSPENDED_COMPLIANCE only while it remembers what to return to', async () => {
      const vendorId = await createVendor(pool);
      expect((await pgError(setVendor(vendorId, `status = 'SUSPENDED_COMPLIANCE'`))).code).toBe(
        CHECK_VIOLATION,
      );
      await setVendor(
        vendorId,
        `status = 'SUSPENDED_COMPLIANCE', status_before_compliance_suspension = 'LIVE'`,
      );
      expect((await vendorRow(vendorId)).status).toBe('SUSPENDED_COMPLIANCE');
      // Never back to a suspension.
      for (const remembered of ['SUSPENDED', 'SUSPENDED_COMPLIANCE']) {
        expect(
          (
            await pgError(
              setVendor(vendorId, `status_before_compliance_suspension = '${remembered}'`),
            )
          ).code,
        ).toBe(CHECK_VIOLATION);
      }
    });

    it('records a verification only with a PAN, an admin and a time together', async () => {
      const vendorId = await createVendor(pool);
      const adminId = await createUser(pool, 'SUPER_ADMIN');

      expect(
        (
          await pgError(
            setVendor(vendorId, 'pan_verified_at = now(), pan_verified_by_user_id = $2', [adminId]),
          )
        ).code,
      ).toBe(CHECK_VIOLATION);
      await setVendor(vendorId, `tax_id = '302118845'`);
      expect((await pgError(setVendor(vendorId, 'pan_verified_at = now()'))).code).toBe(
        CHECK_VIOLATION,
      );
      await setVendor(vendorId, 'pan_verified_at = now(), pan_verified_by_user_id = $2', [adminId]);
      expect((await vendorRow(vendorId)).pan_verified_by_user_id).toBe(adminId);
      // The PAN cannot be removed from under its verification.
      expect((await pgError(setVendor(vendorId, 'tax_id = NULL'))).code).toBe(CHECK_VIOLATION);
      expect((await pgError(pool.query('DELETE FROM users WHERE id = $1', [adminId]))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
    });
  });

  describe('platform_settings', () => {
    it('starts with both delivery modes on and a fee of 50', async () => {
      const row = firstRow(await db.select().from(platformSettings));
      expect(platformSettingsSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        self_delivery_enabled: true,
        platform_fleet_enabled: true,
        platform_delivery_fee_npr: 50,
      });
    });

    it('refuses a negative platform delivery fee', async () => {
      expect(
        (await pgError(pool.query('UPDATE platform_settings SET platform_delivery_fee_npr = -1')))
          .code,
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe('vendor_bank_accounts', () => {
    const account = (vendorId: string, overrides: Record<string, unknown> = {}) => {
      const row = {
        vendor_id: vendorId,
        bank_name: 'Nabil Bank',
        branch_name: 'Thamel',
        account_name: 'Thamel Kirana Pasal',
        account_number: '0123456789012',
        routing_or_swift_code: null,
        is_primary: false,
        ...overrides,
      };
      const names = Object.keys(row);
      return pool.query<{ id: string }>(
        `INSERT INTO vendor_bank_accounts (${names.join(', ')})
         VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
    };

    it('stores an account that matches the contract', async () => {
      const vendorId = await createVendor(pool);
      const { id } = firstRow((await account(vendorId, { is_primary: true })).rows);
      const row = firstRow(
        await db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.id, id)),
      );
      expect(vendorBankAccountSchema.parse(row)).toEqual(row);
      expect(row).toMatchObject({
        vendor_id: vendorId,
        bank_name: 'Nabil Bank',
        account_number: '0123456789012',
        routing_or_swift_code: null,
        is_primary: true,
      });
    });

    it('allows several accounts and exactly one primary per vendor', async () => {
      const vendorId = await createVendor(pool);
      const other = await createVendor(pool);
      await account(vendorId, { is_primary: true });
      await account(vendorId, { account_number: '9998887776665' });
      expect(
        (await pgError(account(vendorId, { account_number: '5554443332221', is_primary: true })))
          .code,
      ).toBe(UNIQUE_VIOLATION);
      // Another shop has its own primary, and may hold the same account number.
      await expect(account(other, { is_primary: true })).resolves.toBeDefined();
    });

    it('does not list the same account twice for one vendor', async () => {
      const vendorId = await createVendor(pool);
      await account(vendorId);
      expect((await pgError(account(vendorId))).code).toBe(UNIQUE_VIOLATION);
      await expect(account(vendorId, { bank_name: 'NIC Asia Bank' })).resolves.toBeDefined();
    });

    it('refuses blank names and malformed numbers or codes', async () => {
      const vendorId = await createVendor(pool);
      for (const overrides of [
        { bank_name: ' ' },
        { branch_name: '' },
        { account_name: '  ' },
        { account_number: '123' },
        { account_number: '0123 4567 89' },
        { account_number: 'x'.repeat(35) },
        { routing_or_swift_code: 'NAR' },
        { routing_or_swift_code: 'NARB-NPKA' },
      ]) {
        expect((await pgError(account(vendorId, overrides))).code).toBe(CHECK_VIOLATION);
      }
      await expect(account(vendorId, { routing_or_swift_code: 'NARBNPKA' })).resolves.toBeDefined();
    });

    it('belongs to a vendor that exists and keeps that vendor from being deleted', async () => {
      const vendorId = await createVendor(pool);
      expect((await pgError(account('11111111-1111-4111-8111-111111111111'))).code).toBe(
        FOREIGN_KEY_VIOLATION,
      );
      await account(vendorId);
      expect(
        (await pgError(pool.query('DELETE FROM vendors WHERE id = $1', [vendorId]))).code,
      ).toBe(FOREIGN_KEY_VIOLATION);
    });

    it('stamps updated_at on every change', async () => {
      const vendorId = await createVendor(pool);
      const { id } = firstRow((await account(vendorId)).rows);
      const before = firstRow(
        await db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.id, id)),
      );
      await pool.query('SELECT pg_sleep(0.02)');
      await pool.query(
        `UPDATE vendor_bank_accounts SET branch_name = 'Durbar Marg' WHERE id = $1`,
        [id],
      );
      const after = firstRow(
        await db.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.id, id)),
      );
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
      expect(after.created_at).toEqual(before.created_at);
    });
  });
});

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, createdAt, primaryId, updatedAt } from './columns';
import { paymentMethodEnum } from './enums';
import { users } from './users';
import { vendors } from './vendors';

/**
 * Phase 25: where a vendor's payouts are sent (SPEC core section 5, "Payouts"). A vendor may
 * hold several accounts; at most one is the primary one, which is where the Tuesday payout run
 * and a Super Admin's manual payout send the money.
 *
 * A row is never deleted while its vendor exists (RESTRICT): a payout record must always be
 * traceable to the account it went to. The account number is stored as given.
 */
export const vendorBankAccounts = pgTable(
  'vendor_bank_accounts',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    bank_name: text().notNull(),
    branch_name: text().notNull(),
    /** The account holder's name, as the bank has it. */
    account_name: text().notNull(),
    account_number: text().notNull(),
    /** The bank's routing (NCHL) or SWIFT code, when the transfer needs one. */
    routing_or_swift_code: text(),
    is_primary: boolean().notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // The vendor's accounts; also serves the vendors FK check.
    index('vendor_bank_accounts_vendor_id_idx').on(t.vendor_id, t.created_at),
    // One primary account per vendor: where its payouts go.
    uniqueIndex('vendor_bank_accounts_primary_uidx')
      .on(t.vendor_id)
      .where(sql`${t.is_primary}`),
    // The same account is not listed twice for one vendor.
    uniqueIndex('vendor_bank_accounts_account_uidx').on(t.vendor_id, t.bank_name, t.account_number),
    check('vendor_bank_accounts_bank_name_check', sql`btrim(${t.bank_name}) <> ''`),
    check('vendor_bank_accounts_branch_name_check', sql`btrim(${t.branch_name}) <> ''`),
    check('vendor_bank_accounts_account_name_check', sql`btrim(${t.account_name}) <> ''`),
    check(
      'vendor_bank_accounts_account_number_check',
      sql`${t.account_number} ~ '^[A-Za-z0-9]{4,34}$'`,
    ),
    check(
      'vendor_bank_accounts_routing_or_swift_code_check',
      sql`${t.routing_or_swift_code} IS NULL OR ${t.routing_or_swift_code} ~ '^[A-Za-z0-9]{4,20}$'`,
    ),
  ],
);

/**
 * 2026-10-21 (SPEC core 9, "Model C credentials"): a Model C shop's own eSewa / Khalti merchant
 * account, into which its customers pay directly. The secret is AES-256-GCM encrypted with the
 * platform's key (VENDOR_CREDENTIALS_KEY) and never leaves the API in clear. A gateway is offered
 * to customers only while `verified_at` is set (a Super Admin's check); changing the secret or
 * the merchant code clears it.
 */
export const vendorGatewayAccounts = pgTable(
  'vendor_gateway_accounts',
  {
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    gateway: paymentMethodEnum().notNull(),
    merchant_code: text().notNull(),
    /** iv (12 bytes) || auth tag (16 bytes) || ciphertext. */
    secret_ciphertext: bytea().notNull(),
    /** The secret's last four characters, shown back to the vendor. */
    secret_hint: text().notNull(),
    verified_at: timestamp({ withTimezone: true, mode: 'date' }),
    verified_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    primaryKey({ name: 'vendor_gateway_accounts_pkey', columns: [t.vendor_id, t.gateway] }),
    index('vendor_gateway_accounts_verified_by_user_id_idx')
      .on(t.verified_by_user_id)
      .where(sql`${t.verified_by_user_id} IS NOT NULL`),
    // One merchant account is never two shops' (a callback names it).
    uniqueIndex('vendor_gateway_accounts_merchant_uidx').on(t.gateway, t.merchant_code),
    check('vendor_gateway_accounts_gateway_check', sql`${t.gateway}::text IN ('ESEWA', 'KHALTI')`),
    check(
      'vendor_gateway_accounts_merchant_code_check',
      sql`${t.merchant_code} ~ '^[A-Za-z0-9_-]{2,100}$'`,
    ),
    check('vendor_gateway_accounts_hint_check', sql`length(${t.secret_hint}) = 4`),
    check(
      'vendor_gateway_accounts_verification_check',
      sql`(${t.verified_at} IS NULL) = (${t.verified_by_user_id} IS NULL)`,
    ),
  ],
);

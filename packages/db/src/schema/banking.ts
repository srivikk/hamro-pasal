import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
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

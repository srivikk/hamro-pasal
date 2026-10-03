import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import { payoutStatusEnum } from './enums';
import { ledgerTransactions } from './ledger';
import { users } from './users';
import { vendors } from './vendors';

/**
 * Phase 22: a vendor's request to withdraw wallet money to its bank. The amount leaves the wallet
 * when the request is made (the VENDOR_PAYOUT journal `hold_transaction_id`: VENDOR_WALLET →
 * PAYOUT_CLEARING), so several requests can never promise the same money. A Super Admin then
 * approves it (the bank transfer's reference is recorded) or rejects it (the
 * VENDOR_PAYOUT_REVERSAL journal `reversal_transaction_id` posts the amount back).
 *
 * It holds no balance: the vendor's money is the double-entry ledger's (SPEC §5).
 */
export const payoutRequests = pgTable(
  'payout_requests',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    amount_npr: npr().notNull(),
    status: payoutStatusEnum().notNull().default('PENDING'),
    /** The client's key for this withdrawal: a retried request resolves to the same row. */
    idempotency_key: text().notNull(),
    hold_transaction_id: uuid()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    reversal_transaction_id: uuid().references(() => ledgerTransactions.id, {
      onDelete: 'restrict',
    }),
    bank_reference: text(),
    rejection_reason: text(),
    decided_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    decided_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('payout_requests_vendor_id_idempotency_key_key').on(t.vendor_id, t.idempotency_key),
    unique('payout_requests_hold_transaction_id_key').on(t.hold_transaction_id),
    // The vendor's own history, and the Super Admin's list (newest first, optionally by status).
    index('payout_requests_vendor_id_created_at_idx').on(t.vendor_id, t.created_at),
    index('payout_requests_created_at_idx').on(t.created_at, t.id),
    index('payout_requests_status_created_at_idx').on(t.status, t.created_at, t.id),
    // Phase 23: the two foreign keys only a decided request carries.
    index('payout_requests_reversal_transaction_id_idx')
      .on(t.reversal_transaction_id)
      .where(sql`${t.reversal_transaction_id} IS NOT NULL`),
    index('payout_requests_decided_by_user_id_idx')
      .on(t.decided_by_user_id)
      .where(sql`${t.decided_by_user_id} IS NOT NULL`),
    check('payout_requests_amount_check', sql`${t.amount_npr} > 0`),
    check('payout_requests_idempotency_key_check', sql`btrim(${t.idempotency_key}) <> ''`),
    // PENDING is undecided; APPROVED names the bank transfer; REJECTED names the reversing journal.
    check(
      'payout_requests_status_check',
      sql`(${t.status} = 'PENDING' AND ${t.decided_at} IS NULL AND ${t.decided_by_user_id} IS NULL
            AND ${t.bank_reference} IS NULL AND ${t.reversal_transaction_id} IS NULL
            AND ${t.rejection_reason} IS NULL)
        OR (${t.status} = 'APPROVED' AND ${t.decided_at} IS NOT NULL
            AND ${t.decided_by_user_id} IS NOT NULL AND ${t.bank_reference} IS NOT NULL
            AND btrim(${t.bank_reference}) <> ''
            AND ${t.reversal_transaction_id} IS NULL AND ${t.rejection_reason} IS NULL)
        OR (${t.status} = 'REJECTED' AND ${t.decided_at} IS NOT NULL
            AND ${t.decided_by_user_id} IS NOT NULL AND ${t.bank_reference} IS NULL
            AND ${t.reversal_transaction_id} IS NOT NULL)`,
    ),
  ],
);

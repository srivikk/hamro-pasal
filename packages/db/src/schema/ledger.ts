import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import {
  ledgerAccountTypeEnum,
  ledgerLineTypeEnum,
  ledgerTransactionKindEnum,
  paymentMethodEnum,
} from './enums';
import { adPurchases } from './marketing';
import { orders } from './orders';
import { users } from './users';
import { vendors } from './vendors';

/**
 * Double-entry accounts. `balance_npr` is maintained only by the apply_ledger_entry trigger.
 * VENDOR_WALLET balances are also mirrored into vendors.wallet_balance_npr, which carries the
 * SPEC §5 floor CHECK and the auto-suspension trigger.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: primaryId(),
    account_type: ledgerAccountTypeEnum().notNull(),
    vendor_id: uuid().references(() => vendors.id, { onDelete: 'restrict' }),
    driver_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    gateway: paymentMethodEnum(),
    /** Step 7.3: owner of a VENDOR_DISPUTE_HOLD account (one per vendor, opened on first use). */
    hold_vendor_id: uuid().references(() => vendors.id, { onDelete: 'restrict' }),
    /** 2026-10-21: owner of a CUSTOMER_WALLET account (one per customer, opened on first use). */
    customer_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    balance_npr: npr().notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('ledger_accounts_vendor_id_key').on(t.vendor_id),
    unique('ledger_accounts_driver_user_id_key').on(t.driver_user_id),
    unique('ledger_accounts_gateway_key').on(t.gateway),
    unique('ledger_accounts_hold_vendor_id_key').on(t.hold_vendor_id),
    unique('ledger_accounts_customer_user_id_key').on(t.customer_user_id),
    // Exactly one escrow and one revenue account.
    uniqueIndex('ledger_accounts_system_singleton_idx')
      .on(t.account_type)
      .where(sql`${t.account_type} IN ('SYSTEM_ESCROW', 'PLATFORM_REVENUE')`),
    // Each account type has exactly its own owner column set.
    check(
      'ledger_accounts_owner_check',
      sql`((${t.account_type} = 'VENDOR_WALLET') = (${t.vendor_id} IS NOT NULL))
        AND ((${t.account_type} = 'DRIVER_WALLET') = (${t.driver_user_id} IS NOT NULL))
        AND ((${t.account_type} = 'GATEWAY_CLEARING') = (${t.gateway} IS NOT NULL))
        AND ((${t.account_type}::text = 'VENDOR_DISPUTE_HOLD') = (${t.hold_vendor_id} IS NOT NULL))
        AND ((${t.account_type}::text = 'CUSTOMER_WALLET') = (${t.customer_user_id} IS NOT NULL))`,
    ),
    // 2026-10-21: a customer can never spend more than its wallet holds.
    check(
      'ledger_accounts_customer_wallet_non_negative_check',
      sql`${t.account_type}::text <> 'CUSTOMER_WALLET' OR ${t.balance_npr} >= 0`,
    ),
    // Step 7.3: the hold only ever holds what an order put there; it is never overdrawn.
    check(
      'ledger_accounts_dispute_hold_non_negative_check',
      sql`${t.account_type}::text <> 'VENDOR_DISPUTE_HOLD' OR ${t.balance_npr} >= 0`,
    ),
    // Only the two external gateways have a clearing account (never COD or the customer wallet).
    check(
      'ledger_accounts_gateway_check',
      sql`${t.gateway} IS NULL OR ${t.gateway}::text IN ('ESEWA', 'KHALTI')`,
    ),
    // Escrow can never pay out more than it holds.
    check(
      'ledger_accounts_escrow_non_negative_check',
      sql`${t.account_type} <> 'SYSTEM_ESCROW' OR ${t.balance_npr} >= 0`,
    ),
  ],
);

/** Journal header. Append-only; its postings must sum to zero (deferred constraint trigger). */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: primaryId(),
    kind: ledgerTransactionKindEnum().notNull(),
    idempotency_key: text().notNull(),
    order_id: uuid().references(() => orders.id, { onDelete: 'restrict' }),
    description: text(),
    created_at: createdAt(),
  },
  (t) => [
    // Replayed webhooks / retried settlements resolve to the already-posted transaction.
    unique('ledger_transactions_idempotency_key_key').on(t.idempotency_key),
    index('ledger_transactions_order_id_idx').on(t.order_id),
    check('ledger_transactions_idempotency_key_check', sql`btrim(${t.idempotency_key}) <> ''`),
    check(
      'ledger_transactions_description_check',
      sql`${t.description} IS NULL OR btrim(${t.description}) <> ''`,
    ),
  ],
);

/** Postings. `amount_npr` is the signed change to the account's balance. Append-only. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: primaryId(),
    transaction_id: uuid()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    account_id: uuid()
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    amount_npr: npr().notNull(),
    created_at: createdAt(),
    /**
     * What the posting is (SPEC core 4, Dual-Layer Billing): commission and ad charges are
     * separate lines. ADJUSTMENT when the journal named none, which is every posting older than
     * migration 0027.
     */
    line_type: ledgerLineTypeEnum().notNull().default('ADJUSTMENT'),
    /** The vendor's own purchase an AD_* line belongs to (SPEC core 8: no unilateral billing). */
    ad_purchase_id: uuid().references(() => adPurchases.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('ledger_entries_transaction_id_idx').on(t.transaction_id),
    index('ledger_entries_account_id_created_at_idx').on(t.account_id, t.created_at),
    index('ledger_entries_ad_purchase_id_idx')
      .on(t.ad_purchase_id)
      .where(sql`${t.ad_purchase_id} IS NOT NULL`),
    check('ledger_entries_amount_non_zero_check', sql`${t.amount_npr} <> 0`),
    // SPEC edge case 6: the database refuses an ad charge that names no purchase.
    check(
      'ledger_entries_ad_line_purchase_check',
      sql`${t.line_type} NOT IN ('AD_FLAT_FEE', 'AD_ORDER_PREMIUM', 'AD_BUDGET_HOLD', 'AD_BUDGET_RELEASE') OR ${t.ad_purchase_id} IS NOT NULL`,
    ),
  ],
);

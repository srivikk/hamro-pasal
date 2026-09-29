import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import { ledgerAccountTypeEnum, ledgerTransactionKindEnum, paymentMethodEnum } from './enums';
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
    balance_npr: npr().notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('ledger_accounts_vendor_id_key').on(t.vendor_id),
    unique('ledger_accounts_driver_user_id_key').on(t.driver_user_id),
    unique('ledger_accounts_gateway_key').on(t.gateway),
    // Exactly one escrow and one revenue account.
    uniqueIndex('ledger_accounts_system_singleton_idx')
      .on(t.account_type)
      .where(sql`${t.account_type} IN ('SYSTEM_ESCROW', 'PLATFORM_REVENUE')`),
    // Each account type has exactly its own owner column set.
    check(
      'ledger_accounts_owner_check',
      sql`((${t.account_type} = 'VENDOR_WALLET') = (${t.vendor_id} IS NOT NULL))
        AND ((${t.account_type} = 'DRIVER_WALLET') = (${t.driver_user_id} IS NOT NULL))
        AND ((${t.account_type} = 'GATEWAY_CLEARING') = (${t.gateway} IS NOT NULL))`,
    ),
    check('ledger_accounts_gateway_check', sql`${t.gateway} IS DISTINCT FROM 'COD'`),
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
  },
  (t) => [
    index('ledger_entries_transaction_id_idx').on(t.transaction_id),
    index('ledger_entries_account_id_created_at_idx').on(t.account_id, t.created_at),
    check('ledger_entries_amount_non_zero_check', sql`${t.amount_npr} <> 0`),
  ],
);

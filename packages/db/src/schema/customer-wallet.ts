import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import { paymentMethodEnum } from './enums';
import { ledgerTransactions } from './ledger';
import { users } from './users';
import { vendors } from './vendors';

/**
 * 2026-10-21: a recharge through a gateway, into the platform's own merchant account, of either a
 * customer's stored-value wallet (SPEC core 12; `vendor_id` null) or a shop's ledger (SPEC core 5:
 * a Model C shop's prepaid balance, or any shop clearing its dues; `vendor_id` set, `user_id` its
 * account). PENDING until the gateway confirms; COMPLETED in the transaction that posts the journal
 * (`transaction_id`). The balances themselves are ledger accounts.
 */
export const walletRecharges = pgTable(
  'wallet_recharges',
  {
    id: primaryId(),
    /** The account that asked: the customer, or the shop's own user. */
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Set for a shop's recharge; null for a customer's wallet. */
    vendor_id: uuid().references(() => vendors.id, { onDelete: 'restrict' }),
    gateway: paymentMethodEnum().notNull(),
    amount_npr: npr().notNull(),
    /** The client's key: a retried initiate is the same recharge. Unique per account. */
    idempotency_key: text().notNull(),
    /** eSewa transaction_uuid: what the callback is matched on. */
    gateway_ref: text().notNull(),
    status: text({ enum: ['PENDING', 'COMPLETED', 'FAILED'] })
      .notNull()
      .default('PENDING'),
    transaction_id: uuid().references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    completed_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    unique('wallet_recharges_user_key_key').on(t.user_id, t.idempotency_key),
    uniqueIndex('wallet_recharges_gateway_ref_uidx').on(t.gateway, t.gateway_ref),
    index('wallet_recharges_user_id_idx').on(t.user_id, t.created_at),
    index('wallet_recharges_vendor_id_idx')
      .on(t.vendor_id)
      .where(sql`${t.vendor_id} IS NOT NULL`),
    index('wallet_recharges_transaction_id_idx')
      .on(t.transaction_id)
      .where(sql`${t.transaction_id} IS NOT NULL`),
    check('wallet_recharges_amount_check', sql`${t.amount_npr} > 0`),
    check('wallet_recharges_gateway_check', sql`${t.gateway}::text IN ('ESEWA', 'KHALTI')`),
    check(
      'wallet_recharges_status_check',
      sql`${t.status} IN ('PENDING', 'COMPLETED', 'FAILED')
        AND (${t.status} = 'COMPLETED') = (${t.transaction_id} IS NOT NULL)
        AND (${t.status} = 'PENDING') = (${t.completed_at} IS NULL)`,
    ),
    check('wallet_recharges_key_check', sql`btrim(${t.idempotency_key}) <> ''`),
  ],
);

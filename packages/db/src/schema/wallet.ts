import { VENDOR_WALLET_HARD_FLOOR_NPR } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId } from './columns';
import { walletLedgerEntryTypeEnum } from './enums';
import { orders } from './orders';
import { vendors } from './vendors';

/**
 * Append-only vendor wallet ledger. Each insert applies `amount_npr` to
 * vendors.wallet_balance_npr through the apply_wallet_ledger_entry trigger.
 * UPDATE and DELETE are rejected by a trigger.
 */
export const walletLedgers = pgTable(
  'wallet_ledgers',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    order_id: uuid(),
    entry_type: walletLedgerEntryTypeEnum().notNull(),
    amount_npr: npr().notNull(),
    description: text(),
    created_at: createdAt(),
  },
  (t) => [
    // An order-linked entry must belong to that order's vendor.
    foreignKey({
      name: 'wallet_ledgers_order_vendor_fk',
      columns: [t.order_id, t.vendor_id],
      foreignColumns: [orders.id, orders.vendor_id],
    }).onDelete('restrict'),
    // Idempotency guard against duplicate webhooks: at most one entry of each type per order.
    unique('wallet_ledgers_order_id_entry_type_key').on(t.order_id, t.entry_type),
    index('wallet_ledgers_vendor_id_created_at_idx').on(t.vendor_id, t.created_at),
    check(
      'wallet_ledgers_amount_sign_check',
      sql`(${t.entry_type} IN ('COD_COMMISSION', 'EMERGENCY_RIDER_FEE') AND ${t.amount_npr} < 0)
        OR (${t.entry_type} IN ('ESCROW_RELEASE', 'TOP_UP') AND ${t.amount_npr} > 0)
        OR (${t.entry_type} = 'ADJUSTMENT' AND ${t.amount_npr} <> 0)`,
    ),
    check(
      'wallet_ledgers_order_required_check',
      sql`${t.entry_type} IN ('TOP_UP', 'ADJUSTMENT') OR ${t.order_id} IS NOT NULL`,
    ),
    check(
      'wallet_ledgers_description_check',
      sql`${t.description} IS NULL OR btrim(${t.description}) <> ''`,
    ),
  ],
);

/** Single-row platform configuration (Super Admin). The row is seeded by the triggers migration. */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: boolean().$type<true>().primaryKey().default(true),
    vendor_wallet_suspension_limit_npr: npr().notNull(),
    updated_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('platform_settings_singleton_check', sql`${t.id}`),
    // Configurable, but never looser than the hard floor enforced on vendors.
    check(
      'platform_settings_wallet_limit_check',
      sql`${t.vendor_wallet_suspension_limit_npr} BETWEEN ${sql.raw(String(VENDOR_WALLET_HARD_FLOOR_NPR))} AND 0`,
    ),
  ],
);

import { VENDOR_WALLET_HARD_FLOOR_NPR } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

import { npr } from './columns';

/** Single-row platform configuration (Super Admin). The row is seeded by the triggers migration. */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: boolean().$type<true>().primaryKey().default(true),
    vendor_wallet_suspension_limit_npr: npr().notNull(),
    // Phase 25 (Super Admin flow step 4): the delivery modes vendors may use. Both false is the
    // global Emergency Stop.
    self_delivery_enabled: boolean().notNull().default(true),
    platform_fleet_enabled: boolean().notNull().default(true),
    // What a customer pays for a platform fleet delivery.
    platform_delivery_fee_npr: npr().notNull().default(50),
    // Step 7.3 (SPEC core 11): checkout stops this many minutes before a shop closes, and this
    // many missed or rejected orders in a row pause a shop.
    last_order_minutes_before_close: integer().notNull().default(15),
    auto_pause_threshold: integer().notNull().default(3),
    updated_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('platform_settings_singleton_check', sql`${t.id}`),
    check(
      'platform_settings_last_order_check',
      sql`${t.last_order_minutes_before_close} BETWEEN 0 AND 120`,
    ),
    check(
      'platform_settings_auto_pause_threshold_check',
      sql`${t.auto_pause_threshold} BETWEEN 1 AND 20`,
    ),
    check('platform_settings_delivery_fee_check', sql`${t.platform_delivery_fee_npr} >= 0`),
    // Configurable, but never looser than the hard floor enforced on vendors.
    check(
      'platform_settings_wallet_limit_check',
      sql`${t.vendor_wallet_suspension_limit_npr} BETWEEN ${sql.raw(String(VENDOR_WALLET_HARD_FLOOR_NPR))} AND 0`,
    ),
  ],
);

import { VENDOR_WALLET_HARD_FLOOR_NPR } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, timestamp } from 'drizzle-orm/pg-core';

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
    updated_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('platform_settings_singleton_check', sql`${t.id}`),
    check('platform_settings_delivery_fee_check', sql`${t.platform_delivery_fee_npr} >= 0`),
    // Configurable, but never looser than the hard floor enforced on vendors.
    check(
      'platform_settings_wallet_limit_check',
      sql`${t.vendor_wallet_suspension_limit_npr} BETWEEN ${sql.raw(String(VENDOR_WALLET_HARD_FLOOR_NPR))} AND 0`,
    ),
  ],
);

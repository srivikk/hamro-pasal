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

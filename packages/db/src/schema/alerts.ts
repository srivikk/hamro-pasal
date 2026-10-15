import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';

import { products, vendors } from './vendors';
import { users } from './users';

/**
 * Step 7.4 (SPEC core 11, Notify Me): a customer waiting for an out-of-stock product. One row per
 * customer and product; the row is deleted when the notice is written (used up, edge case 22).
 */
export const stockAlerts = pgTable(
  'stock_alerts',
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    product_id: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.product_id] }),
    index('stock_alerts_product_idx').on(t.product_id),
  ],
);

/** Step 7.4: a customer waiting for a closed or offline shop to open. Same lifecycle. */
export const shopOpenAlerts = pgTable(
  'shop_open_alerts',
  {
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.vendor_id] }),
    index('shop_open_alerts_vendor_idx').on(t.vendor_id),
  ],
);

import { sql } from 'drizzle-orm';
import { check, index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './columns';
import { deliveryStateEnum } from './enums';
import { orders } from './orders';
import { users } from './users';

/**
 * Phase 21: the platform rider's job for one fleet order (delivery partner flow). Created OFFERED
 * when the shop dispatches a PLATFORM_FLEET / EMERGENCY_FLEET order; a rider accepts it (ASSIGNED),
 * picks the parcel up (PICKED_UP) and hands it over with the customer's code (DELIVERED).
 * SELF_DELIVERY orders have no row: the shop's own staff carry them.
 *
 * There is no code column: the doorstep code is the order's `orders.delivery_otp` (SPEC
 * OrderSnapshot, bcrypt), the one the customer's app shows.
 */
export const deliveries = pgTable(
  'deliveries',
  {
    id: primaryId(),
    order_id: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** Null only while OFFERED. */
    rider_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    state: deliveryStateEnum().notNull().default('OFFERED'),
    accepted_at: timestamp({ withTimezone: true, mode: 'date' }),
    picked_up_at: timestamp({ withTimezone: true, mode: 'date' }),
    /** When the delivery ended: DELIVERED or FAILED. */
    completed_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // One delivery per order.
    uniqueIndex('deliveries_order_id_uidx').on(t.order_id),
    index('deliveries_rider_id_state_idx').on(t.rider_id, t.state),
    index('deliveries_state_idx').on(t.state),
    // An open gig has no rider; every later state has exactly the rider who accepted it.
    check('deliveries_rider_check', sql`(${t.state} = 'OFFERED') = (${t.rider_id} IS NULL)`),
    check(
      'deliveries_accepted_at_check',
      sql`(${t.state} = 'OFFERED') = (${t.accepted_at} IS NULL)`,
    ),
    check(
      'deliveries_picked_up_at_check',
      sql`${t.state} NOT IN ('OFFERED', 'ASSIGNED') OR ${t.picked_up_at} IS NULL`,
    ),
    check(
      'deliveries_completed_at_check',
      sql`(${t.state} IN ('DELIVERED', 'FAILED')) = (${t.completed_at} IS NOT NULL)`,
    ),
    // The code is checked only from PICKED_UP, so a delivered parcel was picked up first.
    check(
      'deliveries_delivered_picked_up_check',
      sql`${t.state} <> 'DELIVERED' OR ${t.picked_up_at} IS NOT NULL`,
    ),
  ],
);

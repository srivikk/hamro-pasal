import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId, updatedAt } from './columns';
import { fulfillmentModeEnum, orderStateEnum, paymentMethodEnum, paymentStatusEnum } from './enums';
import { users } from './users';
import { products, vendors } from './vendors';

/** SPEC `OrderSnapshot`. */
export const orders = pgTable(
  'orders',
  {
    id: primaryId(),
    idempotency_key: text().notNull(),
    customer_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    reservation_id: uuid(),
    driver_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    state: orderStateEnum().notNull().default('PENDING_PAYMENT'),
    subtotal: npr().notNull(),
    delivery_fee: npr().notNull(),
    platform_commission_amount: npr().notNull(),
    fulfillment_locked: fulfillmentModeEnum().notNull(),
    payment_method: paymentMethodEnum().notNull(),
    payment_status: paymentStatusEnum().notNull().default('PENDING'),
    payment_gateway_ref: text(),
    delivery_otp: text().notNull(),
    delivered_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // Idempotency guard: a retried checkout submission cannot create a second order.
    unique('orders_idempotency_key_key').on(t.idempotency_key),
    // Idempotency guard: one order per gateway transaction (eSewa transaction_uuid / Khalti pidx).
    unique('orders_payment_gateway_ref_key').on(t.payment_method, t.payment_gateway_ref),
    // Target for composite FKs that must agree with the order's vendor (e.g. wallet ledger).
    unique('orders_id_vendor_id_key').on(t.id, t.vendor_id),
    // One order per inventory lock.
    unique('orders_reservation_id_key').on(t.reservation_id),
    index('orders_customer_id_idx').on(t.customer_id),
    index('orders_vendor_id_state_idx').on(t.vendor_id, t.state),
    check('orders_idempotency_key_check', sql`btrim(${t.idempotency_key}) <> ''`),
    check('orders_subtotal_check', sql`${t.subtotal} >= 0`),
    check('orders_delivery_fee_check', sql`${t.delivery_fee} >= 0`),
    check('orders_platform_commission_check', sql`${t.platform_commission_amount} >= 0`),
    check(
      'orders_cod_has_no_gateway_ref_check',
      sql`${t.payment_method} <> 'COD' OR ${t.payment_gateway_ref} IS NULL`,
    ),
    // Settlement pays the delivery fee to the rider, so a fleet order cannot be DELIVERED without one.
    check(
      'orders_fleet_delivered_has_driver_check',
      sql`${t.fulfillment_locked} = 'SELF_DELIVERY' OR ${t.state} <> 'DELIVERED' OR ${t.driver_user_id} IS NOT NULL`,
    ),
    // SPEC: delivery_otp is stored as a bcrypt hash only, never the raw 4-digit code.
    check('orders_delivery_otp_bcrypt_check', sql`${t.delivery_otp} ~ '^\\$2[aby]\\$'`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: primaryId(),
    order_id: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    product_id: uuid()
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    product_name: text().notNull(),
    unit_price_npr: npr().notNull(),
    quantity: integer().notNull(),
    created_at: createdAt(),
  },
  (t) => [
    unique('order_items_order_id_product_id_key').on(t.order_id, t.product_id),
    index('order_items_product_id_idx').on(t.product_id),
    check('order_items_product_name_check', sql`btrim(${t.product_name}) <> ''`),
    check('order_items_unit_price_check', sql`${t.unit_price_npr} > 0`),
    check('order_items_quantity_check', sql`${t.quantity} > 0`),
  ],
);

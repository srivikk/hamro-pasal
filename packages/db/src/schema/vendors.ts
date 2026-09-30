import {
  NEPAL_PHONE_PATTERN,
  VENDOR_WALLET_HARD_FLOOR_NPR,
  type VendorFulfillmentMode,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, geoPoint, npr, primaryId, updatedAt } from './columns';
import {
  deliveryScopeEnum,
  fulfillmentModeEnum,
  pricingModelEnum,
  vendorStatusEnum,
} from './enums';
import { users } from './users';

const hardFloor = sql.raw(String(VENDOR_WALLET_HARD_FLOOR_NPR));

export const vendors = pgTable(
  'vendors',
  {
    id: primaryId(),
    user_id: uuid()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
    business_name: text().notNull(),
    phone: text().notNull(),
    status: vendorStatusEnum().notNull().default('SANDBOXED'),
    pricing_model: pricingModelEnum(),
    lock_in_expiry: timestamp({ withTimezone: true, mode: 'date' }),
    scheduled_downgrade: boolean().notNull().default(false),
    commission_rate: numeric({ precision: 5, scale: 4, mode: 'number' }).notNull(),
    delivery_scope: deliveryScopeEnum().notNull(),
    fulfillment_mode: fulfillmentModeEnum().$type<VendorFulfillmentMode>().notNull(),
    radius_km: numeric({ precision: 6, scale: 2, mode: 'number' }).notNull(),
    // Matches customer_addresses.municipality_palika_string for CITY_WIDE delivery (SPEC §2).
    municipality_palika_string: text().notNull(),
    min_order_value: npr().notNull(),
    base_delivery_fee_npr: npr().notNull(),
    location: geoPoint().notNull(),
    wallet_balance_npr: npr().notNull().default(0),
    // Phase 12.5: the status a debt suspension lifts back to (SPEC §5). Null unless SUSPENDED for debt.
    status_before_debt_suspension: vendorStatusEnum().$type<Exclude<VendorStatus, 'SUSPENDED'>>(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('vendors_location_gist').using('gist', t.location),
    // Metre-accurate radius queries cast to geography; this index serves ST_DWithin on that cast.
    index('vendors_location_geography_gist').using('gist', sql`(${t.location}::geography)`),
    index('vendors_status_idx').on(t.status),
    check('vendors_phone_np_check', sql`${t.phone} ~ '${sql.raw(NEPAL_PHONE_PATTERN)}'`),
    check('vendors_business_name_check', sql`btrim(${t.business_name}) <> ''`),
    check(
      'vendors_municipality_palika_string_check',
      sql`btrim(${t.municipality_palika_string}) <> ''`,
    ),
    check('vendors_commission_rate_check', sql`${t.commission_rate} BETWEEN 0 AND 1`),
    // SPEC §4: subscription vendors pay 0% commission.
    check(
      'vendors_subscription_zero_commission_check',
      sql`${t.pricing_model} IS DISTINCT FROM 'SUBSCRIPTION' OR ${t.commission_rate} = 0`,
    ),
    // SPEC vendor flow step 5: a pricing model must be chosen before going LIVE.
    check(
      'vendors_live_requires_pricing_model_check',
      sql`${t.status} <> 'LIVE' OR ${t.pricing_model} IS NOT NULL`,
    ),
    check('vendors_radius_km_check', sql`${t.radius_km} > 0`),
    // EMERGENCY_FLEET is an order-level override, never a vendor's standing mode.
    check(
      'vendors_fulfillment_mode_check',
      sql`${t.fulfillment_mode} IN ('SELF_DELIVERY', 'PLATFORM_FLEET')`,
    ),
    check('vendors_min_order_value_check', sql`${t.min_order_value} >= 0`),
    check('vendors_base_delivery_fee_check', sql`${t.base_delivery_fee_npr} >= 0`),
    // Negative wallet invariant (SPEC §5, edge case #2): an active vendor can never sit below
    // the hard floor. A breaching debit is still recorded, because the
    // enforce_vendor_wallet_limit trigger suspends the vendor in the same row write.
    // Only a SUSPENDED vendor remembers what to return to, and it is never SUSPENDED itself.
    check(
      'vendors_debt_suspension_check',
      sql`${t.status_before_debt_suspension} IS NULL OR (${t.status} = 'SUSPENDED' AND ${t.status_before_debt_suspension} <> 'SUSPENDED')`,
    ),
    check(
      'vendors_wallet_balance_floor_check',
      sql`${t.wallet_balance_npr} >= ${hardFloor} OR ${t.status} = 'SUSPENDED'`,
    ),
  ],
);

export const products = pgTable(
  'products',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    price_npr: npr().notNull(),
    stock_quantity: integer().notNull().default(0),
    is_active: boolean().notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('products_vendor_id_idx').on(t.vendor_id),
    unique('products_vendor_id_name_key').on(t.vendor_id, t.name),
    check('products_name_check', sql`btrim(${t.name}) <> ''`),
    check('products_price_check', sql`${t.price_npr} > 0`),
    check('products_stock_quantity_check', sql`${t.stock_quantity} >= 0`),
  ],
);

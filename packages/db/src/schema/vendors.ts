import {
  DEFAULT_PRODUCT_UNIT,
  MAX_PRODUCT_IMAGES,
  NEPAL_PHONE_PATTERN,
  VENDOR_WALLET_HARD_FLOOR_NPR,
  type JsonValue,
  type VendorFulfillmentMode,
  type VendorStatus,
} from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { categories } from './categories';
import { createdAt, geoPoint, npr, primaryId, updatedAt } from './columns';
import {
  deliveryScopeEnum,
  fulfillmentModeEnum,
  paymentMethodEnum,
  pricingModelEnum,
  settlementModelEnum,
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
    // Step 7.1: "HPV-00042". Taken from vendor_code_seq by next_vendor_code() (migration 0039);
    // a sequence gap is harmless here, unlike a Bill Number. Never reused.
    vendor_code: text()
      .notNull()
      .unique()
      .default(sql`next_vendor_code()`),
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
    base_delivery_fee_npr: npr().notNull().default(0),
    location: geoPoint().notNull(),
    wallet_balance_npr: npr().notNull().default(0),
    // Phase 12.5: the status a debt suspension lifts back to (SPEC §5). Null unless SUSPENDED for debt.
    status_before_debt_suspension: vendorStatusEnum().$type<Exclude<VendorStatus, 'SUSPENDED'>>(),
    // Phase 15: the status a Super Admin Restore returns to. Null unless suspended by an admin.
    status_before_admin_suspension: vendorStatusEnum().$type<Exclude<VendorStatus, 'SUSPENDED'>>(),
    // Phase 25: the status a saved PAN returns the shop to (SPEC core 10). Set while
    // SUSPENDED_COMPLIANCE, and kept if a debt or admin suspension is laid on top of it.
    status_before_compliance_suspension:
      vendorStatusEnum().$type<Exclude<VendorStatus, 'SUSPENDED' | 'SUSPENDED_COMPLIANCE'>>(),
    // Phase 25: the seller's tax identity, copied onto every invoice at issue.
    legal_name: text(),
    registered_address: text(),
    tax_id: text(),
    is_vat_registered: boolean().notNull().default(false),
    // A Super Admin's check of the PAN document. Null freezes payouts, never trading; cleared
    // in the transaction that saves a different PAN.
    pan_verified_at: timestamp({ withTimezone: true, mode: 'date' }),
    pan_verified_by_user_id: uuid().references(() => users.id, { onDelete: 'restrict' }),
    // Phase 34: the uploaded PAN document's object key in the private document store. Not a
    // public URL: the object is read only through the API (the vendor's upload, the admin's view).
    pan_document_url: text(),
    // Phase 25, Delivery Modularity (SPEC §2). The CITY_WIDE tier: Palika names, the shop's own
    // always among them (the vendors_default_serviceable_palikas trigger fills an empty list).
    serviceable_palikas: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    delivery_fee_per_km_npr: npr().notNull().default(0),
    free_delivery_above_npr: npr(),
    // Phase 25, Billing Cycle Lock (SPEC core 4). No FK on the plan here: billing.ts imports
    // this file. The renewal job is the only writer and takes the id from pricing_plans.
    pricing_plan_id: uuid(),
    accepted_payment_methods: paymentMethodEnum()
      .array()
      .notNull()
      .default(sql`'{ESEWA,KHALTI,COD}'::payment_method[]`),
    // Phase 26 (SPEC core 5): Model A COD_CREDIT, Model B PLATFORM_ESCROW, Model C DIRECT_PREPAID.
    // Every shop is Model B until a model change is requested and approved.
    settlement_model: settlementModelEnum().notNull().default('PLATFORM_ESCROW'),
    billing_cycle_started_at: timestamp({ withTimezone: true, mode: 'date' }),
    billing_cycle_ends_at: timestamp({ withTimezone: true, mode: 'date' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('vendors_location_gist').using('gist', t.location),
    // Metre-accurate radius queries cast to geography; this index serves ST_DWithin on that cast.
    index('vendors_location_geography_gist').using('gist', sql`(${t.location}::geography)`),
    index('vendors_status_idx').on(t.status),
    // The renewal job's queue.
    index('vendors_billing_cycle_ends_at_idx')
      .on(t.billing_cycle_ends_at)
      .where(sql`${t.billing_cycle_ends_at} IS NOT NULL`),
    // The CITY_WIDE serviceability test: `:palika = ANY (serviceable_palikas)`.
    index('vendors_serviceable_palikas_idx').using('gin', t.serviceable_palikas),
    // Serves the users FK check; only a verified vendor names an admin.
    index('vendors_pan_verified_by_user_id_idx')
      .on(t.pan_verified_by_user_id)
      .where(sql`${t.pan_verified_by_user_id} IS NOT NULL`),
    check('vendors_vendor_code_check', sql`${t.vendor_code} ~ '^HPV-[0-9]{5,}$'`),
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
      'vendors_admin_suspension_check',
      sql`${t.status_before_admin_suspension} IS NULL OR (${t.status} = 'SUSPENDED' AND ${t.status_before_admin_suspension} <> 'SUSPENDED' AND ${t.status_before_debt_suspension} IS NULL)`,
    ),
    // The status is compared as text: migration 0022 adds the enum value and PostgreSQL does not
    // let a new enum value be used, even in a CHECK, before the transaction that added it commits.
    check(
      'vendors_compliance_suspension_check',
      sql`${t.status}::text <> 'SUSPENDED_COMPLIANCE' OR ${t.status_before_compliance_suspension} IS NOT NULL`,
    ),
    check(
      'vendors_compliance_restore_status_check',
      sql`${t.status_before_compliance_suspension} IS NULL OR ${t.status_before_compliance_suspension}::text NOT IN ('SUSPENDED', 'SUSPENDED_COMPLIANCE')`,
    ),
    check(
      'vendors_pan_document_url_check',
      sql`${t.pan_document_url} IS NULL OR btrim(${t.pan_document_url}) <> ''`,
    ),
    check('vendors_tax_id_check', sql`${t.tax_id} IS NULL OR ${t.tax_id} ~ '^[0-9]{9}$'`),
    check('vendors_legal_name_check', sql`${t.legal_name} IS NULL OR btrim(${t.legal_name}) <> ''`),
    check(
      'vendors_registered_address_check',
      sql`${t.registered_address} IS NULL OR btrim(${t.registered_address}) <> ''`,
    ),
    // Verified by someone, at some time, and only a PAN on file can be verified.
    check(
      'vendors_pan_verification_check',
      sql`(${t.pan_verified_at} IS NULL) = (${t.pan_verified_by_user_id} IS NULL) AND (${t.pan_verified_at} IS NULL OR ${t.tax_id} IS NOT NULL)`,
    ),
    check(
      'vendors_serviceable_palikas_size_check',
      sql`cardinality(${t.serviceable_palikas}) BETWEEN 1 AND 30`,
    ),
    check(
      'vendors_own_palika_served_check',
      sql`${t.municipality_palika_string} = ANY (${t.serviceable_palikas})`,
    ),
    check(
      'vendors_accepted_payment_methods_check',
      sql`cardinality(${t.accepted_payment_methods}) >= 1`,
    ),
    check(
      'vendors_billing_cycle_check',
      sql`(${t.billing_cycle_started_at} IS NULL) = (${t.billing_cycle_ends_at} IS NULL) AND (${t.billing_cycle_ends_at} IS NULL OR ${t.billing_cycle_ends_at} > ${t.billing_cycle_started_at})`,
    ),
    check('vendors_delivery_fee_per_km_check', sql`${t.delivery_fee_per_km_npr} >= 0`),
    check(
      'vendors_free_delivery_above_check',
      sql`${t.free_delivery_above_npr} IS NULL OR ${t.free_delivery_above_npr} > 0`,
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
    // Phase 17: the admin taxonomy node this SKU is mapped to. Null only for older products.
    category_id: uuid().references(() => categories.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    description: text(),
    price_npr: npr().notNull(),
    unit: text().notNull().default(DEFAULT_PRODUCT_UNIT),
    stock_quantity: integer().notNull().default(0),
    image_urls: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    is_active: boolean().notNull().default(true),
    metadata: jsonb()
      .$type<Record<string, JsonValue>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index('products_vendor_id_is_active_idx').on(t.vendor_id, t.is_active),
    index('products_category_id_is_active_idx').on(t.category_id, t.is_active),
    // Full-text search on name + description. 'simple': no stemming, so Nepali and English
    // product names are indexed as written.
    index('products_search_idx').using(
      'gin',
      sql`to_tsvector('simple', ${t.name} || ' ' || coalesce(${t.description}, ''))`,
    ),
    unique('products_vendor_id_name_key').on(t.vendor_id, t.name),
    check('products_name_check', sql`btrim(${t.name}) <> ''`),
    check(
      'products_description_check',
      sql`${t.description} IS NULL OR btrim(${t.description}) <> ''`,
    ),
    check('products_unit_check', sql`btrim(${t.unit}) <> ''`),
    check('products_price_check', sql`${t.price_npr} > 0`),
    check('products_stock_quantity_check', sql`${t.stock_quantity} >= 0`),
    check(
      'products_image_urls_check',
      sql`cardinality(${t.image_urls}) <= ${sql.raw(String(MAX_PRODUCT_IMAGES))}`,
    ),
    check('products_metadata_check', sql`jsonb_typeof(${t.metadata}) = 'object'`),
  ],
);

/**
 * The text `products_search_idx` covers. A search must filter on exactly this expression for the
 * GIN index to serve it.
 */
export const productSearchDocument = sql`to_tsvector('simple', ${products.name} || ' ' || coalesce(${products.description}, ''))`;

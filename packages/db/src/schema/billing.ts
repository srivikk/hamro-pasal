import { settingChangeStatuses, vendorSettings, type AuditState } from '@hamro-pasal/shared-types';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, npr, primaryId } from './columns';
import { pricingModelEnum } from './enums';
import { users } from './users';
import { vendors } from './vendors';

export const vendorSettingEnum = pgEnum('vendor_setting', vendorSettings);
export const settingChangeStatusEnum = pgEnum('setting_change_status', settingChangeStatuses);

/**
 * Phase 25: the pricing plans a Super Admin offers (SPEC core 4, "Onboarding Models"). A plan's
 * model and terms never change: a new rate is a new plan.
 */
export const pricingPlans = pgTable(
  'pricing_plans',
  {
    id: primaryId(),
    name: text().notNull(),
    // Compared as text in the CHECKs: 'FREE' is added to the enum by this same migration.
    model: pricingModelEnum().notNull(),
    /** Percent of each order (0-100); COMMISSION only. */
    commission_rate: numeric({ precision: 5, scale: 2, mode: 'number' }).notNull().default(0),
    monthly_fee_npr: npr().notNull().default(0),
    /** FREE only: how many Billing Cycles the plan lasts. */
    duration_cycles: integer(),
    is_offered: boolean().notNull().default(true),
    is_default: boolean().notNull().default(false),
    created_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    created_at: createdAt(),
  },
  (t) => [
    uniqueIndex('pricing_plans_default_uidx')
      .on(t.is_default)
      .where(sql`${t.is_default}`),
    uniqueIndex('pricing_plans_name_uidx').on(sql`lower(${t.name})`),
    index('pricing_plans_created_by_user_id_idx').on(t.created_by_user_id),
    check('pricing_plans_name_check', sql`btrim(${t.name}) <> ''`),
    check(
      'pricing_plans_commission_check',
      sql`(${t.model}::text = 'COMMISSION' AND ${t.commission_rate} > 0 AND ${t.commission_rate} <= 100) OR (${t.model}::text <> 'COMMISSION' AND ${t.commission_rate} = 0)`,
    ),
    check(
      'pricing_plans_fee_check',
      sql`(${t.model}::text = 'SUBSCRIPTION' AND ${t.monthly_fee_npr} > 0) OR (${t.model}::text <> 'SUBSCRIPTION' AND ${t.monthly_fee_npr} = 0)`,
    ),
    check(
      'pricing_plans_duration_check',
      sql`(${t.model}::text = 'FREE') = (${t.duration_cycles} IS NOT NULL) AND (${t.duration_cycles} IS NULL OR ${t.duration_cycles} > 0)`,
    ),
    check(
      'pricing_plans_default_check',
      sql`NOT ${t.is_default} OR (${t.model}::text = 'COMMISSION' AND ${t.is_offered})`,
    ),
  ],
);

/**
 * Phase 25: the Billing Cycle queue. A row is a vendor's request; only the renewal job applies it,
 * at `effective_from` (the end of the cycle it was requested in).
 */
export const vendorSettingChanges = pgTable(
  'vendor_setting_changes',
  {
    id: primaryId(),
    vendor_id: uuid()
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    setting: vendorSettingEnum().notNull(),
    current_value: jsonb().$type<AuditState>().notNull(),
    requested_value: jsonb().$type<AuditState>().notNull(),
    status: settingChangeStatusEnum().notNull().default('PENDING'),
    requested_by_user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    requested_at: timestamp({ withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    effective_from: timestamp({ withTimezone: true, mode: 'date' }).notNull(),
    closed_at: timestamp({ withTimezone: true, mode: 'date' }),
  },
  (t) => [
    // One waiting change per vendor and setting.
    uniqueIndex('vendor_setting_changes_pending_uidx')
      .on(t.vendor_id, t.setting)
      .where(sql`${t.status} = 'PENDING'`),
    index('vendor_setting_changes_vendor_id_idx').on(t.vendor_id, t.requested_at),
    index('vendor_setting_changes_due_idx')
      .on(t.effective_from)
      .where(sql`${t.status} = 'PENDING'`),
    index('vendor_setting_changes_requested_by_idx').on(t.requested_by_user_id),
    check(
      'vendor_setting_changes_closed_check',
      sql`(${t.status} = 'PENDING') = (${t.closed_at} IS NULL)`,
    ),
  ],
);

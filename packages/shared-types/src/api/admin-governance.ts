import { z } from 'zod';

import { AUDIT_ACTION_PATTERN, auditStateSchema } from '../audit/audit-log';
import { nepalPhoneSchema } from '../domain/entities';
import { userRoleSchema, vendorStatusSchema } from '../domain/enums';
import { panSchema } from './vendor-settings';

/*
 * Super Admin contracts (Phase 26): the audit trail's read side, the platform logistics settings
 * and PAN verification. Served under /api/admin to SUPER_ADMIN tokens only and consumed by
 * apps/admin, which held these as proposed contracts until the API existed.
 */

// Audit log -------------------------------------------------------------------------------

export const ADMIN_AUDIT_LOG_DEFAULT_LIMIT = 50;
export const ADMIN_AUDIT_LOG_MAX_LIMIT = 100;

/**
 * One row of GET /api/admin/audit-logs: the table's columns plus two display names.
 *
 * READ ONLY. `audit_logs` is append-only in the database and every row is written by the service
 * that made the change, in that change's transaction. There is no write schema for it.
 */
export const auditLogViewSchema = z
  .strictObject({
    id: z.uuid(),
    occurred_at: z.iso.datetime(),
    /** The signed-in account that acted; null when the platform's own job did. */
    actor_user_id: z.uuid().nullable(),
    actor_role: userRoleSchema.nullable(),
    /** The scheduled job that acted (BILLING_CYCLE_RENEWAL, …); set exactly when no user did. */
    system_actor: z.string().min(1).nullable(),
    /** The actor as the admin knows them: a shop's business name, a person's name, or the job. */
    actor_name: z.string().min(1),
    /** `text` in the database: new actions appear without an enum migration. */
    action: z.string().regex(new RegExp(AUDIT_ACTION_PATTERN)),
    vendor_id: z.uuid().nullable(),
    vendor_name: z.string().min(1).nullable(),
    entity_type: z.string().min(1),
    entity_id: z.uuid(),
    /** Null for a creation. Both states are returned exactly as stored. */
    before_state: auditStateSchema.nullable(),
    after_state: auditStateSchema,
    request_id: z.string().nullable(),
    ip_address: z.string().nullable(),
    user_agent: z.string().nullable(),
  })
  .refine(
    (entry) =>
      (entry.actor_user_id !== null && entry.actor_role !== null && entry.system_actor === null) ||
      (entry.actor_user_id === null && entry.actor_role === null && entry.system_actor !== null),
    { message: 'An entry has exactly one kind of actor: a user with a role, or a job' },
  );
export type AuditLogView = z.infer<typeof auditLogViewSchema>;

/**
 * GET /api/admin/audit-logs: filters (all optional, combined with AND) and keyset paging, newest
 * first. `entity_id` is the id of the record an entry is about (its target); `cursor` is the
 * `next_cursor` of the previous page. `limit` is read from a query string or a number.
 */
export const adminAuditLogListQuerySchema = z.strictObject({
  vendor_id: z.uuid().optional(),
  actor_user_id: z.uuid().optional(),
  entity_type: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  entity_id: z.uuid().optional(),
  action: z.string().regex(new RegExp(AUDIT_ACTION_PATTERN)).max(60).optional(),
  limit: z.coerce.number().int().min(1).max(ADMIN_AUDIT_LOG_MAX_LIMIT).optional(),
  cursor: z.uuid().optional(),
});
export type AdminAuditLogListQuery = z.output<typeof adminAuditLogListQuerySchema>;

/** One page; `next_cursor` is null on the last page. */
export const adminAuditLogListResponseSchema = z.strictObject({
  entries: z.array(auditLogViewSchema),
  next_cursor: z.uuid().nullable(),
});
export type AdminAuditLogListResponseBody = z.infer<typeof adminAuditLogListResponseSchema>;

// Logistics -------------------------------------------------------------------------------

export const MAX_PLATFORM_DELIVERY_FEE_NPR = 10_000;

/**
 * `platform_settings` is one row keyed by a boolean; this is the id its audit entries carry as
 * `entity_id`, so the trail of the platform's settings can be filtered like any other record's.
 */
export const PLATFORM_SETTINGS_ENTITY_ID = '00000000-0000-4000-8000-000000000001';

/**
 * The body of PUT /api/admin/settings/logistics (SPEC Super Admin flow step 4).
 *
 * The two modes are SPEC's `fulfillment_mode` values: SELF_DELIVERY (the shop's own staff) and
 * PLATFORM_FLEET (the platform's riders, "Platform delivery" in the Vendor App). Both may be
 * off at once: that is the global Emergency Stop (decided 2026-10-07; a nationwide strike, for
 * example), during which no shop takes an order and customers see "Delivery Unavailable".
 */
export const logisticsSettingsWriteSchema = z.strictObject({
  self_delivery_enabled: z.boolean(),
  platform_fleet_enabled: z.boolean(),
  /** What a customer pays for a platform fleet delivery. Shops on self delivery set their own. */
  platform_delivery_fee_npr: z.number().min(0).multipleOf(0.01).max(MAX_PLATFORM_DELIVERY_FEE_NPR),
});
export type LogisticsSettingsWrite = z.infer<typeof logisticsSettingsWriteSchema>;

/** GET and PUT /api/admin/settings/logistics: the settings and how many shops use each mode. */
export const logisticsSettingsViewSchema = z.strictObject({
  self_delivery_enabled: z.boolean(),
  platform_fleet_enabled: z.boolean(),
  platform_delivery_fee_npr: z.number().min(0),
  /** Shops whose `fulfillment_mode` is each one. Read only. */
  self_delivery_vendor_count: z.number().int().min(0),
  platform_fleet_vendor_count: z.number().int().min(0),
  updated_at: z.iso.datetime(),
});
export type LogisticsSettingsView = z.infer<typeof logisticsSettingsViewSchema>;

// Compliance ------------------------------------------------------------------------------

/**
 * A vendor's PAN standing as a Super Admin sees it. The refinements are what the database
 * guarantees today (the CHECKs of migration 0022), no more.
 */
export const complianceVendorViewSchema = z
  .strictObject({
    id: z.uuid(),
    business_name: z.string().min(1),
    phone: nepalPhoneSchema,
    municipality_palika_string: z.string().min(1),
    status: vendorStatusSchema,
    /**
     * The status a saved PAN returns the shop to. Set while a compliance suspension is in force,
     * also when a debt or admin suspension lies on top of it.
     */
    restore_status: vendorStatusSchema.exclude(['SUSPENDED', 'SUSPENDED_COMPLIANCE']).nullable(),
    /** When the compliance sweep suspended the shop; null when it is not so suspended. */
    compliance_suspended_at: z.iso.datetime().nullable(),
    legal_name: z.string().min(1).nullable(),
    tax_id: panSchema.nullable(),
    is_vat_registered: z.boolean(),
    /**
     * When a Super Admin checked the PAN document (decided 2026-10-07). It gates payouts, not
     * visibility: a shop trades from the moment its PAN is saved, but no money is transferred to
     * its bank account while this is null.
     */
    pan_verified_at: z.iso.datetime().nullable(),
  })
  .refine((vendor) => vendor.status !== 'SUSPENDED_COMPLIANCE' || vendor.restore_status !== null, {
    message: 'A compliance suspension remembers the status it returns to',
  })
  .refine((vendor) => vendor.pan_verified_at === null || vendor.tax_id !== null, {
    message: 'Only a PAN on file can be verified',
  });
export type ComplianceVendorView = z.infer<typeof complianceVendorViewSchema>;

/**
 * POST /api/admin/vendors/:id/pan-verification (no body): the vendor with its verification. A
 * repeat answers 200 with the first stamp kept.
 */
export const panVerificationResponseSchema = z.strictObject({
  vendor: complianceVendorViewSchema,
});
export type PanVerificationResponseBody = z.infer<typeof panVerificationResponseSchema>;

/** Where a vendor stands on its PAN, worst first: the order of the Compliance screen. */
export const PAN_STANDINGS = ['SUSPENDED', 'MISSING', 'UNVERIFIED', 'VERIFIED'] as const;
export type PanStanding = (typeof PAN_STANDINGS)[number];

/**
 * SUSPENDED: offline for compliance. MISSING: no PAN on file. UNVERIFIED: a PAN awaiting a Super
 * Admin's check (trading, payouts held). VERIFIED: checked.
 */
export function panStandingOf(
  vendor: Pick<ComplianceVendorView, 'status' | 'tax_id' | 'pan_verified_at'>,
): PanStanding {
  if (vendor.status === 'SUSPENDED_COMPLIANCE') return 'SUSPENDED';
  if (vendor.tax_id === null) return 'MISSING';
  return vendor.pan_verified_at === null ? 'UNVERIFIED' : 'VERIFIED';
}

/**
 * GET /api/admin/compliance/vendors: every vendor (at most `ADMIN_VENDOR_LIST_LIMIT`), grouped
 * by PAN standing in the order of `PAN_STANDINGS`; among suspended shops the longest offline
 * first, otherwise by business name.
 */
export const adminComplianceVendorListResponseSchema = z.strictObject({
  vendors: z.array(complianceVendorViewSchema),
});
export type AdminComplianceVendorListResponseBody = z.infer<
  typeof adminComplianceVendorListResponseSchema
>;

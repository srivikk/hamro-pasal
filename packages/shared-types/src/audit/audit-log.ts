import { z } from 'zod';

import { userRoleSchema } from '../domain/enums';

/**
 * The audit trail (SPEC core section 7, "Audit"): one append-only row per change, written in the
 * same database transaction as the change. This module is the single contract for it: the
 * writer in `@hamro-pasal/db` validates every entry with it, and the row schema is held equal to
 * the Drizzle table at compile time (`packages/db/src/schema/contract.ts`).
 */

/** The record an action is about. One per audited table (or projection). */
export const auditEntityTypes = [
  'vendor',
  'vendor_bank_account',
  'vendor_ledger',
  'vendor_offer',
  'vendor_setting_change',
  'platform_campaign',
  'campaign_opt_in',
  'ad_product',
  'ad_purchase',
  'pricing_plan',
  'settlement_model_request',
  'home_promotion',
  'payout_request',
  'platform_settings',
] as const;
export const auditEntityTypeSchema = z.enum(auditEntityTypes);
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

/**
 * Every audited action and the record it is about. The column is `text`, so adding an action
 * here needs no enum migration; an action is never renamed or removed once rows carry it.
 */
export const AUDIT_ACTION_ENTITY_TYPES = {
  // Discounts (SPEC core 7)
  VENDOR_OFFER_CREATED: 'vendor_offer',
  VENDOR_OFFER_ENDED: 'vendor_offer',
  CAMPAIGN_CREATED: 'platform_campaign',
  CAMPAIGN_UPDATED: 'platform_campaign',
  CAMPAIGN_TERMS_CHANGED: 'platform_campaign',
  CAMPAIGN_OPTED_IN: 'campaign_opt_in',
  CAMPAIGN_OPTED_OUT: 'campaign_opt_in',
  // Ads (SPEC core 8)
  AD_PRODUCT_CREATED: 'ad_product',
  AD_PRODUCT_UPDATED: 'ad_product',
  AD_PURCHASED: 'ad_purchase',
  AD_CANCELLED: 'ad_purchase',
  AD_PAUSED_BUDGET_EXHAUSTED: 'ad_purchase',
  AD_ENDED: 'ad_purchase',
  PROMOTION_CREATED: 'home_promotion',
  PROMOTION_UPDATED: 'home_promotion',
  PROMOTION_DELETED: 'home_promotion',
  // Settlement and money (SPEC core 5)
  SETTLEMENT_MODEL_CHANGE_REQUESTED: 'settlement_model_request',
  SETTLEMENT_MODEL_CHANGE_REJECTED: 'settlement_model_request',
  SETTLEMENT_MODEL_CHANGED: 'vendor_ledger',
  LEDGER_RECHARGED: 'vendor_ledger',
  PAYOUT_PROCESSED: 'vendor_ledger',
  // The retiring vendor-requested payouts (Phase 22): a Super Admin's decision on one.
  PAYOUT_APPROVED: 'payout_request',
  PAYOUT_REJECTED: 'payout_request',
  // Phase 29: the bank transfer of a payout the scheduled run made, confirmed or failed.
  PAYOUT_TRANSFER_COMPLETED: 'payout_request',
  PAYOUT_TRANSFER_FAILED: 'payout_request',
  // Pricing and the billing cycle (SPEC core 4)
  PRICING_PLAN_CREATED: 'pricing_plan',
  PRICING_PLAN_UPDATED: 'pricing_plan',
  VENDOR_SETTING_CHANGE_REQUESTED: 'vendor_setting_change',
  VENDOR_SETTING_CHANGE_APPLIED: 'vendor_setting_change',
  VENDOR_SETTING_CHANGE_WITHDRAWN: 'vendor_setting_change',
  BILLING_CYCLE_STARTED: 'vendor',
  // Compliance and the vendor account (SPEC core 10)
  TAX_IDENTITY_SAVED: 'vendor',
  PAN_VERIFIED: 'vendor',
  PAN_VERIFICATION_CLEARED: 'vendor',
  // Phase 32: the invoices of orders delivered while the shop had no PAN, issued when it saved one.
  WAITING_INVOICES_ISSUED: 'vendor',
  VENDOR_SUSPENDED_FOR_COMPLIANCE: 'vendor',
  VENDOR_DELETION_REQUESTED: 'vendor',
  VENDOR_SUSPENDED_BY_ADMIN: 'vendor',
  VENDOR_RESTORED_BY_ADMIN: 'vendor',
  // Shop settings (SPEC Dual-Fulfillment)
  DELIVERY_SETTINGS_CHANGED: 'vendor',
  // Where payouts are sent (SPEC core 5). The account number is masked in every state.
  BANK_ACCOUNT_ADDED: 'vendor_bank_account',
  BANK_ACCOUNT_UPDATED: 'vendor_bank_account',
  // Platform settings (Super Admin flow 4)
  LOGISTICS_SETTINGS_CHANGED: 'platform_settings',
} as const satisfies Readonly<Record<string, AuditEntityType>>;

export type AuditAction = keyof typeof AUDIT_ACTION_ENTITY_TYPES;
export const auditActions = Object.keys(AUDIT_ACTION_ENTITY_TYPES) as [
  AuditAction,
  ...AuditAction[],
];
export const auditActionSchema = z.enum(auditActions);

/** The shape every action name has; also the table's CHECK. */
export const AUDIT_ACTION_PATTERN = '^[A-Z][A-Z0-9_]*$';

/** A snapshot of the fields that matter for a change: a JSON object, never an array or a scalar. */
export const auditStateSchema = z.record(z.string(), z.json());
export type AuditState = z.infer<typeof auditStateSchema>;

/**
 * Field names that may never be written to the trail, at any depth: the trail is read by every
 * Super Admin and is kept forever, so it holds no credential, code or signature.
 */
export const AUDIT_FORBIDDEN_KEY_PATTERN =
  /(otp|secret|password|token|signature|private_key|ciphertext)/i;

type Json = z.infer<ReturnType<typeof z.json>>;

/** The dotted paths of the forbidden fields in a state ("gateway.secret_key"); empty when clean. */
export function forbiddenAuditKeys(state: AuditState | null): string[] {
  const found: string[] = [];
  const walk = (value: Json, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${path}[${String(index)}]`);
      });
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (AUDIT_FORBIDDEN_KEY_PATTERN.test(key)) found.push(childPath);
      else walk(child, childPath);
    }
  };
  if (state !== null) walk(state, '');
  return found;
}

export const MAX_AUDIT_REQUEST_ID_LENGTH = 100;
export const MAX_AUDIT_USER_AGENT_LENGTH = 500;
export const MAX_AUDIT_JOB_NAME_LENGTH = 60;

/**
 * Who made the change. A signed-in user (the vendor's own account, a Super Admin), with the role
 * the access token carried; or the platform itself, named by the scheduled job that acted
 * (`BILLING_CYCLE_RENEWAL`, `VENDOR_COMPLIANCE_SWEEP`). There is no anonymous actor.
 */
export const auditActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('USER'), user_id: z.uuid(), role: userRoleSchema }),
  z.strictObject({
    kind: z.literal('SYSTEM'),
    job: z.string().regex(new RegExp(AUDIT_ACTION_PATTERN)).max(MAX_AUDIT_JOB_NAME_LENGTH),
  }),
]);
export type AuditActor = z.infer<typeof auditActorSchema>;

/** Where the request came from. All null for a job. */
export const auditContextSchema = z.strictObject({
  request_id: z.string().min(1).max(MAX_AUDIT_REQUEST_ID_LENGTH).nullable(),
  ip_address: z.union([z.ipv4(), z.ipv6()]).nullable(),
  user_agent: z.string().min(1).max(MAX_AUDIT_USER_AGENT_LENGTH).nullable(),
});
export type AuditContext = z.infer<typeof auditContextSchema>;

export const NO_AUDIT_CONTEXT: AuditContext = {
  request_id: null,
  ip_address: null,
  user_agent: null,
};

/**
 * What a service hands the writer. The record's type is not here: it follows from the action
 * (`AUDIT_ACTION_ENTITY_TYPES`), so a call cannot pair an action with the wrong kind of record.
 */
export const auditLogEntrySchema = z
  .strictObject({
    actor: auditActorSchema,
    action: auditActionSchema,
    /** The id of the row the action is about. */
    entity_id: z.uuid(),
    /** The shop the change concerns; null for a platform-wide change. */
    vendor_id: z.uuid().nullable(),
    /** Null exactly for a creation. */
    before_state: auditStateSchema.nullable(),
    after_state: auditStateSchema,
    context: auditContextSchema,
  })
  .superRefine((entry, ctx) => {
    for (const field of ['before_state', 'after_state'] as const) {
      const forbidden = forbiddenAuditKeys(entry[field]);
      if (forbidden.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `Secrets are never audited: ${forbidden.join(', ')}`,
        });
      }
    }
  });
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/** One `audit_logs` row, as stored. */
export const auditLogSchema = z.strictObject({
  id: z.uuid(),
  /** The database clock at the insert, inside the change's transaction. */
  occurred_at: z.date(),
  /** Set for a user's action; null for the platform's own. */
  actor_user_id: z.uuid().nullable(),
  actor_role: userRoleSchema.nullable(),
  /** The job that acted; set exactly when no user did. */
  system_actor: z.string().nullable(),
  action: auditActionSchema,
  vendor_id: z.uuid().nullable(),
  entity_type: auditEntityTypeSchema,
  entity_id: z.uuid(),
  before_state: auditStateSchema.nullable(),
  after_state: auditStateSchema,
  request_id: z.string().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
});
export type AuditLog = z.infer<typeof auditLogSchema>;

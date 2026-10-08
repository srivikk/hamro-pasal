import {
  adminAuditLogListQuerySchema,
  adminDeadLetterListQuerySchema,
  adminPayoutApproveRequestSchema,
  adminPayoutFailRequestSchema,
  adminPayoutFinalizeRequestSchema,
  adminPayoutListQuerySchema,
  adminPayoutRejectRequestSchema,
  idParamSchema,
  logisticsSettingsWriteSchema,
  PAN_STANDINGS,
  panStandingOf,
  pricingPlanCreateRequestSchema,
  pricingPlanUpdateRequestSchema,
  settlementPayoutRequestSchema,
  type AdminAuditLogListResponseBody,
  type AdminComplianceVendorListResponseBody,
  type AdminPricingPlanListResponseBody,
  type AdminPricingPlanResponseBody,
  type AdminSettlementListResponseBody,
  type AdminPayoutDecisionResponseBody,
  type AdminPayoutListResponseBody,
  type AdminPayoutView,
  type AdminDeadLetterListResponseBody,
  type AdminDeadLetterRetryResponseBody,
  type AdminVendorListResponseBody,
  type AdminVendorOverrideResponseBody,
  type AdminVendorSuspension,
  type AdminVendorView,
  type AuditLogView,
  type ComplianceVendorView,
  type DeadLetterView,
  type LogisticsSettingsView,
  type PanVerificationResponseBody,
  type PricingPlanView,
  type SettlementPayoutResponseBody,
  type SettlementVendorView,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';
import { z } from 'zod';

import type { SettlementModelRequestService } from '../settlement/settlement-model-request-service';

import type { AdminComplianceService, ComplianceVendor } from '../admin/admin-compliance-service';
import type { AdminVendorRow, AdminVendorService } from '../admin/admin-vendor-service';
import type { AuditLogRow, AuditLogService } from '../admin/audit-log-service';
import type { DeadLetterRow, DeadLetterService } from '../admin/dead-letter-service';
import type {
  LogisticsSettings,
  LogisticsSettingsService,
} from '../admin/logistics-settings-service';
import type { PricingPlanService, PricingPlanWithCount } from '../admin/pricing-plan-service';
import type { CategoryService } from '../catalog/category-service';
import type { ProductService } from '../catalog/product-service';
import type { AdminPayoutRow, AdminPayoutService } from '../finance/admin-payout-service';
import type { AdminSettlementService, SettlementVendor } from '../finance/admin-settlement-service';
import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import { mountAdminMarketing, type AdminMarketingServices } from './admin-marketing';
import { mountAdminSettlementModelRequests } from './settlement-model-requests';
import { mountAdminCatalog } from './catalog';
import { payoutView } from './vendor-finance';

export interface AdminRouterServices {
  readonly deadLetters: DeadLetterService;
  readonly vendors: AdminVendorService;
  /** Phase 17: the Master Category Taxonomy and the products overview. */
  readonly categories: CategoryService;
  readonly products: ProductService;
  /** Phase 22: vendors' payout requests. */
  readonly payouts: AdminPayoutService;
  /** Phase 26: the audit trail (read only), the logistics settings and PAN verification. */
  readonly auditLogs: AuditLogService;
  readonly logistics: LogisticsSettingsService;
  readonly compliance: AdminComplianceService;
  /** Phase 26: settlement payouts (behind the PAN gate) and the pricing plans. */
  readonly settlements: AdminSettlementService;
  readonly pricingPlans: PricingPlanService;
  /** Phase 26: campaigns, the ad price list and the Home promotions. */
  readonly marketing: AdminMarketingServices;
  /** Phase 27: vendors' settlement model change requests. */
  readonly settlementModelRequests: SettlementModelRequestService;
}

const jsonValueSchema = z.json();

const vendorIdParamSchema = z.strictObject({ vendor_id: z.uuid() });

/** The stored value as JSON when it is JSON (a domain event), else null (a poison pill). */
function parsedPayload(text: string | null): DeadLetterView['payload'] {
  if (text === null || text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const result = jsonValueSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function deadLetterView(row: DeadLetterRow): DeadLetterView {
  const rawValue = row.message_value === null ? null : row.message_value.toString('utf8');
  return {
    id: row.id,
    status: row.status,
    consumer: row.consumer,
    source_topic: row.source_topic,
    source_partition: row.source_partition,
    source_offset: row.source_offset,
    dead_letter_topic: row.dead_letter_topic,
    message_key: row.message_key === null ? null : row.message_key.toString('utf8'),
    event_id: row.event_id,
    event_type: row.event_type,
    payload: parsedPayload(rawValue),
    raw_value: rawValue,
    headers: row.headers,
    attempts: row.attempts,
    error_name: row.error_name,
    error_message: row.error_message,
    failed_at: row.failed_at.toISOString(),
    retry_requested_at: row.retry_requested_at?.toISOString() ?? null,
    retry_requested_by: row.retry_requested_by,
    replayed_at: row.replayed_at?.toISOString() ?? null,
    replay_attempts: row.replay_attempts,
    last_replay_error: row.last_replay_error,
    replay_of_id: row.replay_of_id,
  };
}

function suspensionOf(vendor: AdminVendorRow): AdminVendorSuspension {
  if (vendor.status !== 'SUSPENDED') return 'NONE';
  if (vendor.status_before_admin_suspension !== null) return 'ADMIN';
  if (vendor.status_before_debt_suspension !== null) return 'DEBT';
  return 'UNSPECIFIED';
}

export function adminVendorView(vendor: AdminVendorRow): AdminVendorView {
  return {
    id: vendor.id,
    business_name: vendor.business_name,
    phone: vendor.phone,
    status: vendor.status,
    suspension: suspensionOf(vendor),
    restore_status: vendor.status_before_admin_suspension ?? vendor.status_before_debt_suspension,
    wallet_balance_npr: vendor.wallet_balance_npr,
    pricing_model: vendor.pricing_model,
    fulfillment_mode: vendor.fulfillment_mode,
    municipality_palika_string: vendor.municipality_palika_string,
    created_at: vendor.created_at.toISOString(),
  };
}

export function adminPayoutView({
  payout,
  vendor,
  primaryBankAccount,
}: AdminPayoutRow): AdminPayoutView {
  return {
    ...payoutView(payout),
    primary_bank_account:
      primaryBankAccount === null
        ? null
        : {
            id: primaryBankAccount.id,
            bank_name: primaryBankAccount.bank_name,
            branch_name: primaryBankAccount.branch_name,
            account_name: primaryBankAccount.account_name,
            account_number: primaryBankAccount.account_number,
            routing_or_swift_code: primaryBankAccount.routing_or_swift_code,
          },
    vendor: {
      id: vendor.id,
      business_name: vendor.businessName,
      phone: vendor.phone,
      wallet_balance_npr: vendor.walletBalanceNpr,
    },
    decided_by: payout.decided_by_user_id,
  };
}

/** One audit entry with its two display names. Both states are returned exactly as stored. */
export function auditLogView(row: AuditLogRow): AuditLogView {
  const { entry } = row;
  return {
    id: entry.id,
    occurred_at: entry.occurred_at.toISOString(),
    actor_user_id: entry.actor_user_id,
    actor_role: entry.actor_role,
    system_actor: entry.system_actor,
    // A job by its name; a vendor by its shop; anyone else by their name, else their number.
    actor_name:
      entry.system_actor ??
      row.actorShopName ??
      row.actorFirstName ??
      row.actorPhone ??
      'Unknown account',
    action: entry.action,
    vendor_id: entry.vendor_id,
    vendor_name: row.vendorName,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    before_state: entry.before_state,
    after_state: entry.after_state,
    request_id: entry.request_id,
    ip_address: entry.ip_address,
    user_agent: entry.user_agent,
  };
}

export function logisticsSettingsView(logistics: LogisticsSettings): LogisticsSettingsView {
  return {
    self_delivery_enabled: logistics.settings.self_delivery_enabled,
    platform_fleet_enabled: logistics.settings.platform_fleet_enabled,
    platform_delivery_fee_npr: logistics.settings.platform_delivery_fee_npr,
    self_delivery_vendor_count: logistics.selfDeliveryVendorCount,
    platform_fleet_vendor_count: logistics.platformFleetVendorCount,
    updated_at: logistics.settings.updated_at.toISOString(),
  };
}

export function complianceVendorView({
  vendor,
  complianceSuspendedAt,
}: ComplianceVendor): ComplianceVendorView {
  return {
    id: vendor.id,
    business_name: vendor.business_name,
    phone: vendor.phone,
    municipality_palika_string: vendor.municipality_palika_string,
    status: vendor.status,
    restore_status: vendor.status_before_compliance_suspension,
    compliance_suspended_at: complianceSuspendedAt?.toISOString() ?? null,
    legal_name: vendor.legal_name,
    tax_id: vendor.tax_id,
    is_vat_registered: vendor.is_vat_registered,
    pan_verified_at: vendor.pan_verified_at?.toISOString() ?? null,
  };
}

export function settlementVendorView(settlement: SettlementVendor): SettlementVendorView {
  const { vendor } = settlement;
  return {
    vendor_id: vendor.id,
    business_name: vendor.business_name,
    phone: vendor.phone,
    settlement_model: vendor.settlement_model,
    available_for_payout_npr: settlement.availableForPayoutNpr,
    pending_escrow_npr: settlement.pendingEscrowNpr,
    tax_id: vendor.tax_id,
    pan_verified_at: vendor.pan_verified_at?.toISOString() ?? null,
    primary_bank_account:
      settlement.primaryBankAccount === null
        ? null
        : {
            id: settlement.primaryBankAccount.id,
            bank_name: settlement.primaryBankAccount.bank_name,
            branch_name: settlement.primaryBankAccount.branch_name,
            account_name: settlement.primaryBankAccount.account_name,
            account_number: settlement.primaryBankAccount.account_number,
            routing_or_swift_code: settlement.primaryBankAccount.routing_or_swift_code,
          },
  };
}

export function pricingPlanView({ plan, vendorCount }: PricingPlanWithCount): PricingPlanView {
  return {
    id: plan.id,
    name: plan.name,
    model: plan.model,
    commission_rate: plan.commission_rate,
    monthly_fee_npr: plan.monthly_fee_npr,
    duration_cycles: plan.duration_cycles,
    is_offered: plan.is_offered,
    is_default: plan.is_default,
    vendor_count: vendorCount,
    created_at: plan.created_at.toISOString(),
  };
}

/** Worst PAN standing first; among suspended shops the longest offline first; then by name. */
export function byPanStanding(vendors: readonly ComplianceVendorView[]): ComplianceVendorView[] {
  return [...vendors].sort((a, b) => {
    const rank = PAN_STANDINGS.indexOf(panStandingOf(a)) - PAN_STANDINGS.indexOf(panStandingOf(b));
    if (rank !== 0) return rank;
    const since = (a.compliance_suspended_at ?? '').localeCompare(b.compliance_suspended_at ?? '');
    return since !== 0 ? since : a.business_name.localeCompare(b.business_name);
  });
}

/**
 * Mounted at /api/admin behind requireAuth(SUPER_ADMIN) (Phase 15): the DLQ monitor and the vendor
 * standing overrides used by apps/admin. Every response is `no-store`.
 */
export function adminRouter({
  deadLetters,
  vendors,
  categories,
  products,
  payouts,
  auditLogs,
  logistics,
  compliance,
  settlements,
  pricingPlans,
  marketing,
  settlementModelRequests,
}: AdminRouterServices): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/dlq', async (req, res) => {
    const query = parseInput(adminDeadLetterListQuerySchema, { ...req.query });
    const page = await deadLetters.list(query);
    const body: AdminDeadLetterListResponseBody = {
      dead_letters: page.rows.map(deadLetterView),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  /** 202: the worker republishes the message to its source topic, then marks it REPLAYED. */
  router.post('/dlq/:id/retry', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const row = await deadLetters.requestRetry(id, authOf(req).userId);
    const body: AdminDeadLetterRetryResponseBody = { dead_letter: deadLetterView(row) };
    res.status(202).json(body);
  });

  router.get('/vendors', async (_req, res) => {
    const list = await vendors.list();
    const body: AdminVendorListResponseBody = {
      vendors: list.vendors.map(adminVendorView),
      suspension_limit_npr: list.suspensionLimitNpr,
    };
    res.json(body);
  });

  router.post('/vendors/:id/suspend', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { override, vendor } = await vendors.suspend(
      authOf(req).userId,
      id,
      auditContextOf(req, res),
    );
    const body: AdminVendorOverrideResponseBody = {
      vendor: adminVendorView(vendor),
      previous_status: override.fromStatus,
    };
    res.json(body);
  });

  router.post('/vendors/:id/restore', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { override, vendor } = await vendors.restore(
      authOf(req).userId,
      id,
      auditContextOf(req, res),
    );
    const body: AdminVendorOverrideResponseBody = {
      vendor: adminVendorView(vendor),
      previous_status: override.fromStatus,
    };
    res.json(body);
  });

  router.get('/finance/payouts', async (req, res) => {
    const query = parseInput(adminPayoutListQuerySchema, { ...req.query });
    const page = await payouts.list(query);
    const body: AdminPayoutListResponseBody = {
      payouts: page.rows.map(adminPayoutView),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  /** The amount left the wallet when it was requested: approving records the bank transfer. */
  router.post('/finance/payouts/:id/approve', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminPayoutApproveRequestSchema, req.body);
    const row = await payouts.approve(
      authOf(req).userId,
      id,
      input.bank_reference,
      auditContextOf(req, res),
    );
    const body: AdminPayoutDecisionResponseBody = { payout: adminPayoutView(row) };
    res.json(body);
  });

  /** Posts the held amount back to the vendor's wallet. A body is optional. */
  router.post('/finance/payouts/:id/reject', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminPayoutRejectRequestSchema, (req.body as unknown) ?? {});
    const row = await payouts.reject(
      authOf(req).userId,
      id,
      input.reason,
      auditContextOf(req, res),
    );
    const body: AdminPayoutDecisionResponseBody = { payout: adminPayoutView(row) };
    res.json(body);
  });

  /**
   * Phase 30. The admin made the bank transfer of a payout the scheduled run prepared
   * (PROCESSING_BANK_TRANSFER): records its reference; the payout is COMPLETED.
   */
  router.post('/finance/payouts/:id/finalize', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminPayoutFinalizeRequestSchema, req.body);
    const row = await payouts.finalize(
      authOf(req).userId,
      id,
      input.bank_reference,
      auditContextOf(req, res),
    );
    const body: AdminPayoutDecisionResponseBody = { payout: adminPayoutView(row) };
    res.json(body);
  });

  /**
   * Phase 30. The bank transfer of such a payout could not be made: the amount is posted back to
   * the vendor's wallet and the payout is FAILED. A body is optional.
   */
  router.post('/finance/payouts/:id/fail', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminPayoutFailRequestSchema, (req.body as unknown) ?? {});
    const row = await payouts.fail(authOf(req).userId, id, input.reason, auditContextOf(req, res));
    const body: AdminPayoutDecisionResponseBody = { payout: adminPayoutView(row) };
    res.json(body);
  });

  /**
   * Phase 26. The audit trail, newest first. GET only: nothing under /api/admin writes, edits or
   * removes an entry.
   */
  router.get('/audit-logs', async (req, res) => {
    const query = parseInput(adminAuditLogListQuerySchema, { ...req.query });
    const page = await auditLogs.list(query);
    const body: AdminAuditLogListResponseBody = {
      entries: page.rows.map(auditLogView),
      next_cursor: page.nextCursor,
    };
    res.json(body);
  });

  router.get('/settings/logistics', async (_req, res) => {
    const body: LogisticsSettingsView = logisticsSettingsView(await logistics.get());
    res.json(body);
  });

  /** Replaces the three settings. Both modes off is accepted: the global Emergency Stop. */
  router.put('/settings/logistics', async (req, res) => {
    const input = parseInput(logisticsSettingsWriteSchema, req.body);
    const body: LogisticsSettingsView = logisticsSettingsView(
      await logistics.update(authOf(req).userId, input, auditContextOf(req, res)),
    );
    res.json(body);
  });

  /** Gates payouts, never trading: the vendor's status is not touched. No body. */
  router.post('/vendors/:id/pan-verification', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const body: PanVerificationResponseBody = {
      vendor: complianceVendorView(
        await compliance.verifyPan(authOf(req).userId, id, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  /** Phase 26. Every vendor's PAN standing, grouped worst first (the Compliance screen). */
  router.get('/compliance/vendors', async (_req, res) => {
    const body: AdminComplianceVendorListResponseBody = {
      vendors: byPanStanding((await compliance.list()).map(complianceVendorView)),
    };
    res.json(body);
  });

  /** Model B shops the platform owes money to now, each with its PAN verification. */
  router.get('/finance/settlements', async (_req, res) => {
    const body: AdminSettlementListResponseBody = {
      vendors: (await settlements.list()).map(settlementVendorView),
    };
    res.json(body);
  });

  /**
   * A Super Admin's manual payout. 422 PAN_NOT_VERIFIED while the vendor's PAN document is
   * unverified: the gate is read under the vendor row lock, before anything is posted.
   */
  router.post('/finance/settlements/:vendor_id/payout', async (req, res) => {
    const { vendor_id: vendorId } = parseInput(vendorIdParamSchema, { ...req.params });
    const input = parseInput(settlementPayoutRequestSchema, req.body);
    const result = await settlements.payout(
      authOf(req).userId,
      vendorId,
      input,
      auditContextOf(req, res),
    );
    const body: SettlementPayoutResponseBody = {
      payout: payoutView(result.payout),
      vendor: settlementVendorView(result.vendor),
      replayed: result.replayed,
    };
    res.status(result.replayed ? 200 : 201).json(body);
  });

  router.get('/pricing-plans', async (_req, res) => {
    const body: AdminPricingPlanListResponseBody = {
      plans: (await pricingPlans.list()).map(pricingPlanView),
    };
    res.json(body);
  });

  router.post('/pricing-plans', async (req, res) => {
    const input = parseInput(pricingPlanCreateRequestSchema, req.body);
    const body: AdminPricingPlanResponseBody = {
      plan: pricingPlanView(
        await pricingPlans.create(authOf(req).userId, input, auditContextOf(req, res)),
      ),
    };
    res.status(201).json(body);
  });

  /**
   * The name and the two switches only. The body is strict: a model, rate, fee or duration is
   * 400 VALIDATION_FAILED, because a published plan's terms never change.
   */
  router.patch('/pricing-plans/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(pricingPlanUpdateRequestSchema, req.body);
    const body: AdminPricingPlanResponseBody = {
      plan: pricingPlanView(
        await pricingPlans.update(authOf(req).userId, id, input, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  mountAdminMarketing(router, marketing);
  mountAdminSettlementModelRequests(router, settlementModelRequests);
  mountAdminCatalog(router, categories, products);

  return router;
}

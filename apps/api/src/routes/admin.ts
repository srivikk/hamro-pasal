import {
  adminDeadLetterListQuerySchema,
  adminPayoutApproveRequestSchema,
  adminPayoutListQuerySchema,
  adminPayoutRejectRequestSchema,
  idParamSchema,
  type AdminPayoutDecisionResponseBody,
  type AdminPayoutListResponseBody,
  type AdminPayoutView,
  type AdminDeadLetterListResponseBody,
  type AdminDeadLetterRetryResponseBody,
  type AdminVendorListResponseBody,
  type AdminVendorOverrideResponseBody,
  type AdminVendorSuspension,
  type AdminVendorView,
  type DeadLetterView,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';
import { z } from 'zod';

import type { AdminVendorRow, AdminVendorService } from '../admin/admin-vendor-service';
import type { DeadLetterRow, DeadLetterService } from '../admin/dead-letter-service';
import type { CategoryService } from '../catalog/category-service';
import type { ProductService } from '../catalog/product-service';
import type { AdminPayoutRow, AdminPayoutService } from '../finance/admin-payout-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
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
}

const jsonValueSchema = z.json();

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

export function adminPayoutView({ payout, vendor }: AdminPayoutRow): AdminPayoutView {
  return {
    ...payoutView(payout),
    vendor: {
      id: vendor.id,
      business_name: vendor.businessName,
      phone: vendor.phone,
      wallet_balance_npr: vendor.walletBalanceNpr,
    },
    decided_by: payout.decided_by_user_id,
  };
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
    const { override, vendor } = await vendors.suspend(authOf(req).userId, id);
    const body: AdminVendorOverrideResponseBody = {
      vendor: adminVendorView(vendor),
      previous_status: override.fromStatus,
    };
    res.json(body);
  });

  router.post('/vendors/:id/restore', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { override, vendor } = await vendors.restore(authOf(req).userId, id);
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
    const row = await payouts.approve(authOf(req).userId, id, input.bank_reference);
    const body: AdminPayoutDecisionResponseBody = { payout: adminPayoutView(row) };
    res.json(body);
  });

  /** Posts the held amount back to the vendor's wallet. A body is optional. */
  router.post('/finance/payouts/:id/reject', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adminPayoutRejectRequestSchema, (req.body as unknown) ?? {});
    const row = await payouts.reject(authOf(req).userId, id, input.reason);
    const body: AdminPayoutDecisionResponseBody = { payout: adminPayoutView(row) };
    res.json(body);
  });

  mountAdminCatalog(router, categories, products);

  return router;
}

import {
  adminModelChangeRejectRequestSchema,
  adminModelChangeRequestListQuerySchema,
  idParamSchema,
  settlementModelChangeRequestSchema,
  type AdminModelChangeDecisionResponseBody,
  type AdminModelChangeRequestListResponseBody,
  type AuditActor,
  type ModelChangeRequestView,
  type VendorModelChangeRequestResponseBody,
  type VendorModelChangeRequestView,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';

import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type {
  ModelChangeRequestRow,
  ModelChangeRequestWithShop,
  SettlementModelRequestService,
} from '../settlement/settlement-model-request-service';

function userActor(req: Request): AuditActor & { kind: 'USER' } {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

export function vendorModelChangeRequestView(
  request: ModelChangeRequestRow,
): VendorModelChangeRequestView {
  return {
    id: request.id,
    from_model: request.from_model,
    requested_model: request.requested_model,
    status: request.status,
    requested_at: request.requested_at.toISOString(),
    decided_at: request.decided_at?.toISOString() ?? null,
    rejection_reason: request.rejection_reason,
  };
}

export function modelChangeRequestView(row: ModelChangeRequestWithShop): ModelChangeRequestView {
  return {
    ...vendorModelChangeRequestView(row.request),
    vendor_id: row.request.vendor_id,
    business_name: row.businessName,
    phone: row.phone,
    current_model: row.currentModel,
    open_order_count: row.openOrderCount,
    ledger_balance_npr: row.ledgerBalanceNpr,
    active_ad_count: row.activeAdCount,
  };
}

/**
 * Mounted at /api/vendor/ledger behind requireAuth(VENDOR) (Phase 27). A shop of any status may
 * ask to change its settlement model; the change itself waits for a Super Admin.
 */
export function vendorLedgerRouter(requests: SettlementModelRequestService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/settlement-model', async (req, res) => {
    const input = parseInput(settlementModelChangeRequestSchema, req.body);
    const created = await requests.request(userActor(req), input.model, auditContextOf(req, res));
    const body: VendorModelChangeRequestResponseBody = {
      request: vendorModelChangeRequestView(created),
    };
    res.status(201).json(body);
  });

  return router;
}

/**
 * The Super Admin's side, on the /api/admin router (SUPER_ADMIN, no-store). There is no route
 * that creates a request and no body that names a model: an admin decides what the vendor asked.
 */
export function mountAdminSettlementModelRequests(
  router: Router,
  requests: SettlementModelRequestService,
): void {
  router.get('/settlement-model-requests', async (req, res) => {
    const query = parseInput(adminModelChangeRequestListQuerySchema, { ...req.query });
    const body: AdminModelChangeRequestListResponseBody = {
      requests: (await requests.list(query.status)).map(modelChangeRequestView),
    };
    res.json(body);
  });

  router.post('/settlement-model-requests/:id/approve', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const body: AdminModelChangeDecisionResponseBody = {
      request: modelChangeRequestView(
        await requests.approve(userActor(req), id, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  router.post('/settlement-model-requests/:id/reject', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    // The body is optional: a rejection without a reason sends none.
    const input = parseInput(adminModelChangeRejectRequestSchema, req.body ?? {});
    const body: AdminModelChangeDecisionResponseBody = {
      request: modelChangeRequestView(
        await requests.reject(userActor(req), id, input.reason, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });
}

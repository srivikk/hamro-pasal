import {
  vendorDeactivateRequestSchema,
  type VendorDeactivateResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { VendorDeactivationService } from '../vendor/vendor-deactivation-service';

/**
 * Mounted at /api/vendor/account behind requireAuth(VENDOR) (Phase 36). The shop is always the
 * caller's own, in any status: a suspended vendor may close its shop too (once it owes nothing).
 */
export function vendorDeactivationRouter(deactivation: VendorDeactivationService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** Soft delete: the shop becomes DEACTIVATED and the account can no longer sign in. */
  router.post('/deactivate', async (req, res) => {
    parseInput(vendorDeactivateRequestSchema, req.body);
    const actor = auditActorOf(req);
    if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
    const result = await deactivation.deactivate(actor, auditContextOf(req, res));
    const body: VendorDeactivateResponseBody = {
      vendor_id: result.vendorId,
      status: 'DEACTIVATED',
      deactivated_at: result.deactivatedAt.toISOString(),
      cancelled_ad_count: result.cancelledAdCount,
      returned_npr: result.returnedNpr,
      closed_opt_in_count: result.closedOptInCount,
      wallet_balance_npr: result.walletBalanceNpr,
    };
    res.json(body);
  });

  return router;
}

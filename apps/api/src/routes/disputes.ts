import {
  adminDisputeListQuerySchema,
  escalationRequestSchema,
  idParamSchema,
  resolutionRequestSchema,
  type AdminDisputeListResponseBody,
  type AdminDisputeResponseBody,
  type EscalationResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { AdminDisputeService } from '../disputes/admin-dispute-service';
import type { DisputeService } from '../disputes/dispute-service';
import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';

/**
 * POST /:id/escalate (step 7.3, SPEC core 6). Mounted under /api/orders behind customer auth and
 * under /api/vendors/orders behind vendor auth: the caller must be that order's customer or its
 * vendor (anyone else: 404).
 */
export function escalationRouter(disputes: DisputeService): Router {
  const router = Router();
  router.post('/:id/escalate', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { reason } = parseInput(escalationRequestSchema, req.body);
    const { userId, role } = authOf(req);
    const body: EscalationResponseBody = {
      conversation: await disputes.escalate({ userId, role }, id, reason, auditContextOf(req, res)),
    };
    res.status(200).json(body);
  });
  return router;
}

/** Mounted at /api/admin/disputes behind SUPER_ADMIN auth (step 7.3, Super Admin flow 9). */
export function adminDisputesRouter(disputes: AdminDisputeService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const query = parseInput(adminDisputeListQuerySchema, { ...req.query });
    const page = await disputes.list(query);
    const body: AdminDisputeListResponseBody = {
      disputes: [...page.disputes],
      next_cursor: page.nextCursor,
    };
    res.status(200).json(body);
  });

  router.post('/:id/resolve', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const request = parseInput(resolutionRequestSchema, req.body);
    const body: AdminDisputeResponseBody = {
      dispute: await disputes.resolve(authOf(req).userId, id, request, auditContextOf(req, res)),
    };
    res.status(200).json(body);
  });

  return router;
}

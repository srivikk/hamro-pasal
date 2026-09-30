import { idParamSchema, type ChatHistoryResponseBody } from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { DisputeService } from '../disputes/dispute-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';

/**
 * Mounted at /api/orders behind requireAuth(CUSTOMER, VENDOR, SUPER_ADMIN), ahead of the
 * customer-only orders router: only /:id/chat is served here; every other path falls through.
 */
export function orderChatRouter(disputes: DisputeService): Router {
  const router = Router();

  /**
   * The dispute transcript of an order, oldest first (customer journey 11, Super Admin flow 3).
   * Senders pass through the same privacy filter as the /chat broadcast: id, first name and role
   * only. 404 for anyone who is not a party to the order (or a Super Admin).
   */
  router.get('/:id/chat', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { userId, role } = authOf(req);
    const body: ChatHistoryResponseBody = {
      messages: await disputes.transcript({ userId, role }, id),
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  return router;
}

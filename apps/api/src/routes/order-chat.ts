import {
  chatHttpSendRequestSchema,
  idParamSchema,
  type ChatHistoryResponseBody,
  type ChatHttpSendResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { publicChatMessage } from '../disputes/chat-message-view';
import type { DisputeService } from '../disputes/dispute-service';
import { authOf } from '../http/auth';
import { HttpError } from '../http/http-error';
import { parseInput } from '../http/validate';
import type { ChatRoomBroadcaster } from '../realtime/chat-broadcaster';
import type { EvidenceStorage } from '../uploads/evidence-storage';

/**
 * Mounted at /api/orders behind requireAuth(CUSTOMER, VENDOR, SUPER_ADMIN), ahead of the
 * customer-only orders router: only /:id/chat is served here; every other path falls through.
 */
export function orderChatRouter(
  disputes: DisputeService,
  evidence: Pick<EvidenceStorage, 'isEvidenceUrl'>,
  broadcaster: ChatRoomBroadcaster,
): Router {
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

  /**
   * 2026-10-21 (Task 5): one message over HTTP, under the same rules as `chat:new_message` on
   * /chat: the customer and the shop inside the window (or while escalated), a Super Admin once
   * escalated; attachments must be this order's uploaded evidence. Stored first, then broadcast to
   * the order's room, so socket clients see it at once. A retried `client_id` returns the stored
   * message (201 either way).
   */
  router.post('/:id/chat', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(chatHttpSendRequestSchema, req.body);
    const { userId, role } = authOf(req);
    await disputes.assertAccess({ userId, role }, id);
    if (!input.attachments.every((attachment) => evidence.isEvidenceUrl(id, attachment.url))) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Request validation failed', {
        issues: [
          {
            path: 'attachments',
            message: 'Attachments must be uploaded with POST /api/uploads/dispute-evidence',
          },
        ],
      });
    }
    const sender = await disputes.participantProfile(userId);
    if (sender === null) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');

    const { message: stored } = await disputes.recordMessage({
      orderId: id,
      senderUserId: userId,
      clientId: input.client_id,
      body: input.body,
      attachments: input.attachments,
    });
    const message = publicChatMessage(stored, id, sender);
    broadcaster.emit(id, message);
    const body: ChatHttpSendResponseBody = { message };
    res.status(201).set('Cache-Control', 'no-store').json(body);
  });

  return router;
}

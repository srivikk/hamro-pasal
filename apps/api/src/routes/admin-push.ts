import {
  adminNotificationListQuerySchema,
  adminNotificationRequestSchema,
  adminVendorSearchQuerySchema,
  type AdminNotificationListResponseBody,
  type AdminNotificationSentResponseBody,
  type AdminVendorSearchResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { AdminNotificationService } from '../notifications/admin-notification-service';

/**
 * Mounted at /api/admin behind SUPER_ADMIN auth, before the admin router (step 7.5): only these
 * three paths are served here; every other path falls through.
 */
export function adminPushRouter(notifications: AdminNotificationService): Router {
  const router = Router();

  router.get('/vendors/search', async (req, res) => {
    const query = parseInput(adminVendorSearchQuerySchema, { ...req.query });
    const body: AdminVendorSearchResponseBody = {
      vendors: await notifications.searchVendors(query),
    };
    res.setHeader('Cache-Control', 'no-store').status(200).json(body);
  });

  router.post('/notifications', async (req, res) => {
    const request = parseInput(adminNotificationRequestSchema, req.body);
    const sent = await notifications.send(authOf(req).userId, request, auditContextOf(req, res));
    const body: AdminNotificationSentResponseBody = {
      message_id: sent.messageId,
      recipient_count: sent.recipientCount,
    };
    res.status(202).json(body);
  });

  router.get('/notifications', async (req, res) => {
    const query = parseInput(adminNotificationListQuerySchema, { ...req.query });
    const page = await notifications.list(query);
    const body: AdminNotificationListResponseBody = {
      notifications: [...page.notifications],
      next_cursor: page.nextCursor,
    };
    res.setHeader('Cache-Control', 'no-store').status(200).json(body);
  });

  return router;
}

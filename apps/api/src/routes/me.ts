import {
  idParamSchema,
  mePatchRequestSchema,
  notificationListQuerySchema,
  type MeResponseBody,
  type NotificationListResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';

import type { MeService } from '../account/me-service';
import type { InboxOwner, NotificationCentreService } from '../account/notification-centre-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';

function ownerOf(req: Request): InboxOwner {
  const { userId, role } = authOf(req);
  return { userId, signedInAsCustomer: role === 'CUSTOMER' };
}

/** Mounted at /api/me behind requireAuth (any role). Step 7.1. */
export function meRouter(me: MeService, inbox: NotificationCentreService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const body: MeResponseBody = { user: await me.get(authOf(req).userId) };
    res.status(200).json(body);
  });

  /** Only the keys sent change. 409 EMAIL_TAKEN when another account has the address. */
  router.patch('/', async (req, res) => {
    const patch = parseInput(mePatchRequestSchema, req.body);
    const body: MeResponseBody = { user: await me.update(authOf(req).userId, patch) };
    res.status(200).json(body);
  });

  router.get('/notifications', async (req, res) => {
    const query = parseInput(notificationListQuerySchema, req.query);
    const page = await inbox.list(ownerOf(req), query);
    const body: NotificationListResponseBody = {
      notifications: page.notifications,
      next_cursor: page.nextCursor,
    };
    res.status(200).json(body);
  });

  router.get('/notifications/unread-count', async (req, res) => {
    res.status(200).json({ unread: await inbox.unreadCount(ownerOf(req)) });
  });

  router.post('/notifications/read-all', async (req, res) => {
    res.status(200).json({ marked: await inbox.readAll(ownerOf(req)) });
  });

  router.post('/notifications/:id/read', async (req, res) => {
    const { id } = parseInput(idParamSchema, req.params);
    res.status(200).json({ notification: await inbox.read(ownerOf(req), id) });
  });

  return router;
}

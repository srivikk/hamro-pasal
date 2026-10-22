import {
  adminAuthLogListQuerySchema,
  adminOtpRevealRequestSchema,
  type AdminAuthLogListResponseBody,
  type AdminOtpRevealResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { AuthLogService } from '../auth/auth-log-service';
import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';

/**
 * Mounted at /api/admin/auth-logs behind SUPER_ADMIN auth (2026-10-21, Task 5): the
 * Authentication Logs and the guarded reveal of a live login code. Never cached.
 */
export function adminAuthLogsRouter(logs: AuthLogService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/', async (req, res) => {
    const query = parseInput(adminAuthLogListQuerySchema, { ...req.query });
    const page = await logs.list(query);
    const body: AdminAuthLogListResponseBody = {
      entries: [...page.entries],
      next_cursor: page.nextCursor,
      reveal_enabled: page.revealEnabled,
    };
    res.json(body);
  });

  router.post('/reveal', async (req, res) => {
    const input = parseInput(adminOtpRevealRequestSchema, req.body);
    const live = await logs.reveal(authOf(req).userId, input, auditContextOf(req, res));
    const body: AdminOtpRevealResponseBody = {
      phone: live.phone,
      code: live.code,
      expires_in_seconds: Math.max(0, Math.floor(live.expiresInMs / 1000)),
      attempts_used: live.attemptsUsed,
    };
    res.json(body);
  });

  return router;
}

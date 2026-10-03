import {
  deviceTokenRegisterRequestSchema,
  type DeviceTokenRegisterResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { DeviceTokenService } from '../notifications/device-token-service';

/** Mounted at /api/notifications behind requireAuth (any role). */
export function notificationsRouter(deviceTokens: DeviceTokenService): Router {
  const router = Router();

  /**
   * SPEC implicit requirement 1 (Phase 20): the app registers its Expo push token after sign-in
   * and on every launch with a session. The account is the access token's subject, never a body
   * field. Idempotent: 200 for a new token, a repeat, and a token taken over from another account.
   */
  router.post('/device-token', async (req, res) => {
    const input = parseInput(deviceTokenRegisterRequestSchema, req.body);
    const registered = await deviceTokens.register({
      userId: authOf(req).userId,
      token: input.token,
      platform: input.platform,
    });
    const body: DeviceTokenRegisterResponseBody = {
      device_token: {
        token: registered.token,
        platform: registered.platform,
        updated_at: registered.updatedAt.toISOString(),
      },
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(body);
  });

  return router;
}

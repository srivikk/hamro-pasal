import { checkoutRequestSchema, lockStatusQuerySchema } from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { CheckoutService } from '../checkout/checkout-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import {
  lockView,
  orderView,
  type CheckoutResponseBody,
  type LockStatusResponseBody,
} from './views';

/** Mounted at /api/cart behind requireAuth(CUSTOMER). */
export function cartRouter(checkout: CheckoutService): Router {
  const router = Router();

  /** SPEC §3 / journey 6: lock the cart for 600 s and create the order. */
  router.post('/checkout', async (req, res) => {
    const request = parseInput(checkoutRequestSchema, req.body);
    const result = await checkout.checkout(authOf(req).userId, request);
    const body: CheckoutResponseBody = {
      order: orderView(result.order),
      reservation: {
        id: result.reservation.id,
        expires_at: result.reservation.expiresAt?.toISOString() ?? null,
      },
      delivery_otp: result.deliveryOtp,
      replayed: result.replayed,
    };
    res.status(result.replayed ? 200 : 201).json(body);
  });

  /** SPEC edge case 1: after a reconnect, TTL > 0 resumes checkout, otherwise purge the cart. */
  router.get('/lock-status', async (req, res) => {
    const { order_id: orderId } = parseInput(lockStatusQuerySchema, { ...req.query });
    const { order, lock } = await checkout.getOrderLockStatus(authOf(req).userId, orderId);
    const body: LockStatusResponseBody = { order: orderView(order), lock: lockView(lock) };
    res.json(body);
  });

  return router;
}

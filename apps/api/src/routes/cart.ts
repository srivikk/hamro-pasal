import {
  cartQuoteRequestSchema,
  checkoutRequestSchema,
  lockStatusQuerySchema,
  type CartQuoteResponseBody,
  type CheckoutResponseBody,
  type LockStatusResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { CheckoutService } from '../checkout/checkout-service';
import { authOf } from '../http/auth';
import { pricedCartView } from '../checkout/pricing';
import { toNpr, toPaisa } from '../ledger/money';
import { parseInput } from '../http/validate';
import { lockView, orderView } from './views';

/** Mounted at /api/cart behind requireAuth(CUSTOMER). */
export function cartRouter(checkout: CheckoutService): Router {
  const router = Router();

  /** SPEC core 9: the cart as checkout will price it. No lock, no order. */
  router.post('/quote', async (req, res) => {
    const request = parseInput(cartQuoteRequestSchema, req.body);
    const quote = await checkout.quote(authOf(req).userId, request);
    const body: CartQuoteResponseBody = {
      ...pricedCartView(quote.priced),
      // Judged on the subtotal before discounts, as the delivery charge is (SPEC core 2).
      free_delivery_threshold_npr: quote.freeDeliveryThresholdNpr,
      free_delivery_remaining_npr:
        quote.freeDeliveryThresholdNpr === null
          ? null
          : toNpr(
              Math.max(0, toPaisa(quote.freeDeliveryThresholdNpr) - quote.priced.subtotalPaisa),
            ),
      distance_km: Math.round(quote.distanceKm * 1000) / 1000,
      delivery_available: quote.deliveryAvailable,
      payment_options: [...quote.paymentOptions],
    };
    res.json(body);
  });

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

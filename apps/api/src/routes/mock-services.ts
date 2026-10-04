import {
  paymentInitiateRequestSchema,
  type PaymentStatusResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { parseInput } from '../http/validate';
import type { MockPaymentService } from '../payments/mock-payment-service';
import { paymentView } from './views';

/**
 * Mounted at /api/test, and only outside production with MOCK_SERVICES on (see createApp).
 * No token: it is called from a terminal during a local run.
 */
export function testRouter(mockPayments: MockPaymentService): Router {
  const router = Router();

  /** Pays a prepaid order as its gateway would have: PAID, escrow credited, order PLACED. */
  router.post('/mock-payment', async (req, res) => {
    const { order_id: orderId } = parseInput(paymentInitiateRequestSchema, req.body);
    const result = await mockPayments.pay(orderId);
    console.info(
      `[MOCK PAYMENT] ${result.gateway} order ${orderId}: ${result.payment.paymentStatus}, ${result.payment.orderState}`,
    );
    const body: PaymentStatusResponseBody = {
      status: result.status,
      payment: paymentView(result.payment),
    };
    res.json(body);
  });

  return router;
}

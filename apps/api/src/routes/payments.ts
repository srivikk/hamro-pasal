import {
  esewaWebhookRequestSchema,
  khaltiLookupRequestSchema,
  paymentInitiateRequestSchema,
  type EsewaInitiateResponseBody,
  type KhaltiInitiateResponseBody,
  type PaymentStatusResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type RequestHandler } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { EsewaService } from '../payments/esewa/esewa-service';
import type { KhaltiService } from '../payments/khalti/khalti-service';
import { paymentView } from './views';

export interface PaymentRouterDependencies {
  readonly esewa: EsewaService;
  readonly khalti: KhaltiService;
  /** requireAuth(CUSTOMER), applied per route: the eSewa webhook is authenticated by HMAC. */
  readonly customerAuth: RequestHandler;
}

/** Mounted at /api/payments. */
export function paymentsRouter({ esewa, khalti, customerAuth }: PaymentRouterDependencies): Router {
  const router = Router();

  router.post('/esewa/initiate', customerAuth, async (req, res) => {
    const { order_id: orderId } = parseInput(paymentInitiateRequestSchema, req.body);
    const request = await esewa.initiate(authOf(req).userId, orderId);
    const body: EsewaInitiateResponseBody = {
      payment_url: request.paymentUrl,
      method: 'POST',
      fields: { ...request.fields },
    };
    res.json(body);
  });

  /** The success-redirect `data` forwarded by the app; trusted only via the eSewa signature. */
  router.post('/esewa/webhook', async (req, res) => {
    const { data } = parseInput(esewaWebhookRequestSchema, req.body);
    const result = await esewa.handleCallback(data);
    const body: PaymentStatusResponseBody = {
      status: result.status,
      payment: paymentView(result.payment),
    };
    res.json(body);
  });

  router.post('/khalti/initiate', customerAuth, async (req, res) => {
    const { order_id: orderId } = parseInput(paymentInitiateRequestSchema, req.body);
    const request = await khalti.initiate(authOf(req).userId, orderId);
    const body: KhaltiInitiateResponseBody = {
      pidx: request.pidx,
      payment_url: request.paymentUrl,
      expires_at: request.expiresAt,
    };
    res.json(body);
  });

  router.post('/khalti/lookup', customerAuth, async (req, res) => {
    const { pidx } = parseInput(khaltiLookupRequestSchema, req.body);
    const result = await khalti.lookup(authOf(req).userId, pidx);
    const body: PaymentStatusResponseBody = {
      status: result.status,
      payment: paymentView(result.payment),
    };
    res.json(body);
  });

  return router;
}

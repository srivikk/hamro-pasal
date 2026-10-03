import {
  deliveryOtpRequestSchema,
  idParamSchema,
  type DeliveryListResponseBody,
  type DeliveryResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import type { DeliveryService } from '../deliveries/delivery-service';
import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import { deliveryConfirmedBody, deliveryView } from './views';

/** Mounted at /api/deliveries behind requireAuth(DRIVER): the platform rider's side. */
export function deliveriesRouter(deliveries: DeliveryService): Router {
  const router = Router();

  /** Open gigs and the rider's own deliveries still on the road. */
  router.get('/', async (req, res) => {
    const { userId } = authOf(req);
    const listed = await deliveries.list(userId);
    const body: DeliveryListResponseBody = {
      deliveries: listed.map((delivery) => deliveryView(delivery, userId)),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  /** Driver flow step 1: take an open gig. */
  router.post('/:id/accept', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { userId } = authOf(req);
    const { delivery } = await deliveries.accept(userId, id);
    const body: DeliveryResponseBody = { delivery: deliveryView(delivery, userId) };
    res.json(body);
  });

  /** Driver flow step 2: "Picked Up" at the shop. */
  router.post('/:id/pickup', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { userId } = authOf(req);
    const { delivery } = await deliveries.pickUp(userId, id);
    const body: DeliveryResponseBody = { delivery: deliveryView(delivery, userId) };
    res.json(body);
  });

  /**
   * Driver flow step 5: the customer's 4-digit code at the door. A match delivers and settles
   * the order; a wrong code is 401 INVALID_OTP, and the fifth wrong code locks the order (429).
   */
  router.post('/:id/complete', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { delivery_otp } = parseInput(deliveryOtpRequestSchema, req.body);
    const { order } = await deliveries.complete(authOf(req).userId, id, delivery_otp);
    res.json(deliveryConfirmedBody(order));
  });

  return router;
}

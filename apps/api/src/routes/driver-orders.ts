import {
  deliveryOtpRequestSchema,
  idParamSchema,
  type DriverOrderListResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { DriverOrderService } from '../orders/driver-order-service';
import { deliveryConfirmedBody, driverOrderView } from './views';

/** Mounted at /api/driver/orders behind requireAuth(DRIVER): the platform rider's side. */
export function driverOrdersRouter(driverOrders: DriverOrderService): Router {
  const router = Router();

  /** Fleet orders out for delivery that this rider carries or may claim. */
  router.get('/', async (req, res) => {
    const { userId } = authOf(req);
    const active = await driverOrders.listActive(userId);
    const body: DriverOrderListResponseBody = {
      orders: active.map((order) => driverOrderView(order, userId)),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  /**
   * Driver flow step 5: the customer's 4-digit code at the door. A match delivers and settles
   * the order; a wrong code is 401 INVALID_OTP, and the fifth wrong code locks the order (429).
   */
  router.post('/:id/deliver', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { delivery_otp } = parseInput(deliveryOtpRequestSchema, req.body);
    const { order } = await driverOrders.deliver(authOf(req).userId, id, delivery_otp);
    res.json(deliveryConfirmedBody(order));
  });

  return router;
}

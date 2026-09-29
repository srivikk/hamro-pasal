import {
  idParamSchema,
  type CancelOrderResponseBody,
  type OrderDetailResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { OrderService } from '../orders/order-service';
import { orderSnapshotView } from './views';

/** Mounted at /api/orders behind requireAuth(CUSTOMER). */
export function ordersRouter(orderService: OrderService): Router {
  const router = Router();

  /** Order tracking (customer journey 9): the full snapshot, including delivered_at and address. */
  router.get('/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const body: OrderDetailResponseBody = {
      order: orderSnapshotView(await orderService.getOrder(authOf(req).userId, id)),
    };
    res.json(body);
  });

  /** Customer journey 8: cancel within 60 s of the order's creation (server clock). */
  router.post('/:id/cancel', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const { order } = await orderService.cancel(authOf(req).userId, id);
    const body: CancelOrderResponseBody = {
      order_id: order.id,
      state: 'CANCELED',
      refund_required: order.refund_required,
    };
    res.json(body);
  });

  return router;
}

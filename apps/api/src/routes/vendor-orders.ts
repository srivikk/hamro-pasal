import {
  idParamSchema,
  vendorReviewSubmitRequestSchema,
  type ReviewSubmitResponseBody,
  type VendorOrderDecisionResponseBody,
  type VendorOrderListResponseBody,
} from '@hamro-pasal/shared-types';
import { Router } from 'express';

import { authOf } from '../http/auth';
import { parseInput } from '../http/validate';
import type { VendorDecisionResult, VendorOrderService } from '../orders/vendor-order-service';
import type { ReviewService } from '../reviews/review-service';
import { reviewView, vendorOrderView } from './views';

export interface VendorOrdersRouterServices {
  readonly reviews: ReviewService;
  readonly vendorOrders: VendorOrderService;
}

function decisionBody({ order }: VendorDecisionResult): VendorOrderDecisionResponseBody {
  if (order.state !== 'PREPARING' && order.state !== 'CANCELED') {
    throw new Error(`Order ${order.id} decision left it in ${order.state}`);
  }
  return { order_id: order.id, state: order.state, refund_required: order.refund_required };
}

/** Mounted at /api/vendors/orders behind requireAuth(VENDOR): the vendor's side of an order. */
export function vendorOrdersRouter({ reviews, vendorOrders }: VendorOrdersRouterServices): Router {
  const router = Router();

  /** Vendor flow step 6: the dashboard's open orders (new ones first, then those being packed). */
  router.get('/', async (req, res) => {
    const open = await vendorOrders.listOpen(authOf(req).userId);
    const body: VendorOrderListResponseBody = { orders: open.map(vendorOrderView) };
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  /** Vendor flow step 7: accept a PLACED order, which moves it to PREPARING. */
  router.post('/:id/accept', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    res.json(decisionBody(await vendorOrders.accept(authOf(req).userId, id)));
  });

  /** Reject a PLACED order: CANCELED, stock restored, prepaid escrow flagged for refund. */
  router.post('/:id/reject', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    res.json(decisionBody(await vendorOrders.reject(authOf(req).userId, id)));
  });

  /**
   * SPEC §6: the vendor rates the customer of one of its DELIVERED orders. The same quarantine
   * transaction as the customer's review: if the customer has already reviewed, both reviews are
   * published now; otherwise this one stays QUARANTINED until they do or 48 h pass.
   */
  router.post('/:id/reviews', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(vendorReviewSubmitRequestSchema, req.body);
    const review = await reviews.submit({
      orderId: id,
      direction: 'VENDOR_TO_CUSTOMER',
      authorUserId: authOf(req).userId,
      rating: input.rating,
      feedback: input.feedback,
    });
    const body: ReviewSubmitResponseBody = { review: reviewView(review) };
    res.status(201).json(body);
  });

  return router;
}

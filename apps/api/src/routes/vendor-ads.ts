import {
  adPurchaseRequestSchema,
  idParamSchema,
  type AdPurchaseCancelResponseBody,
  type AdPurchaseListResponseBody,
  type AdPurchaseResponseBody,
  type AdPurchaseView,
  type AuditActor,
  type VendorAdProductListResponseBody,
} from '@hamro-pasal/shared-types';
import { Router, type Request } from 'express';

import { auditActorOf, auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import { toNpr, toPaisa } from '../ledger/money';
import type { AdPurchaseService, AdPurchaseWithProduct } from '../marketing/ad-purchase-service';

/** The signed-in vendor as the actor of an audited change (the router sits behind requireAuth). */
function vendorActor(req: Request): AuditActor & { kind: 'USER' } {
  const actor = auditActorOf(req);
  if (actor.kind !== 'USER') throw new Error('A signed-in caller is always a user');
  return actor;
}

export function adPurchaseView({ purchase, product }: AdPurchaseWithProduct): AdPurchaseView {
  // Only a Model B flat fee is collected after the purchase; a cancelled ad owes nothing.
  const feeStillDue =
    purchase.billing_model === 'FLAT_RATE' &&
    purchase.settlement_model === 'PLATFORM_ESCROW' &&
    purchase.status !== 'CANCELLED';
  return {
    id: purchase.id,
    ad_product_id: purchase.ad_product_id,
    product_name: product.name,
    slot: product.slot,
    billing_model: purchase.billing_model,
    price_npr: purchase.price_npr,
    budget_npr: purchase.budget_npr,
    settlement_model: purchase.settlement_model,
    status: purchase.status,
    starts_at: purchase.starts_at.toISOString(),
    ends_at: purchase.ends_at.toISOString(),
    amount_paid_npr: purchase.amount_paid_npr,
    amount_due_npr: feeStillDue
      ? toNpr(Math.max(0, toPaisa(purchase.price_npr) - toPaisa(purchase.amount_paid_npr)))
      : 0,
    agreed_at: purchase.agreed_at.toISOString(),
  };
}

/**
 * Mounted at /api/vendor/ads behind requireAuth(VENDOR) (Phase 28, SPEC core 8). The only way an
 * ad comes to exist: the shop's own account chooses a product and agrees to its price. No body
 * names a vendor; the shop is always the caller's.
 */
export function vendorAdsRouter(adPurchases: AdPurchaseService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** The placements on sale, with what this shop can spend and how it would be charged. */
  router.get('/products', async (req, res) => {
    const market = await adPurchases.marketplace(vendorActor(req).user_id);
    const body: VendorAdProductListResponseBody = {
      settlement_model: market.settlementModel,
      available_for_ads_npr: market.availableForAdsNpr,
      products: market.products.map(({ product, rechargeRequiredNpr }) => ({
        id: product.id,
        name: product.name,
        slot: product.slot,
        billing_model: product.billing_model,
        price_npr: product.price_npr,
        duration_days: product.duration_days,
        collection:
          market.settlementModel === 'PLATFORM_ESCROW' ? 'PAYOUT_DEDUCTION' : 'LEDGER_BALANCE',
        recharge_required_npr: rechargeRequiredNpr,
      })),
    };
    res.json(body);
  });

  router.get('/purchases', async (req, res) => {
    const body: AdPurchaseListResponseBody = {
      purchases: (await adPurchases.list(vendorActor(req).user_id)).map(adPurchaseView),
    };
    res.json(body);
  });

  /** 201 for a new purchase; 200 with `replayed` for a retry of the same idempotency key. */
  router.post('/purchases', async (req, res) => {
    const input = parseInput(adPurchaseRequestSchema, req.body);
    const result = await adPurchases.purchase(vendorActor(req), input, auditContextOf(req, res));
    const body: AdPurchaseResponseBody = {
      purchase: adPurchaseView(result),
      available_for_ads_npr: result.availableForAdsNpr,
      replayed: result.replayed,
    };
    res.status(result.replayed ? 200 : 201).json(body);
  });

  /** 200, also on repeat. */
  router.post('/purchases/:id/cancel', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const result = await adPurchases.cancel(vendorActor(req), id, auditContextOf(req, res));
    const body: AdPurchaseCancelResponseBody = {
      purchase: adPurchaseView(result),
      available_for_ads_npr: result.availableForAdsNpr,
    };
    res.json(body);
  });

  return router;
}

import {
  adPurchaseCancelResponseSchema,
  adPurchaseListResponseSchema,
  adPurchaseResponseSchema,
  vendorAdProductListResponseSchema,
  type AdPurchaseCancelResponseBody,
  type AdPurchaseListResponseBody,
  type AdPurchaseRequest,
  type AdPurchaseResponseBody,
  type VendorAdProductListResponseBody,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const VENDOR_AD_PRODUCTS_PATH = '/api/vendor/ads/products';
export const VENDOR_AD_PURCHASES_PATH = '/api/vendor/ads/purchases';

/** Server codes the Ads section words itself. */
export const AD_ERROR_CODES = {
  exceedsPendingPayout: 'AD_EXCEEDS_PENDING_PAYOUT',
  rechargeRequired: 'LEDGER_RECHARGE_REQUIRED',
  budgetInvalid: 'AD_BUDGET_INVALID',
  startOutOfRange: 'AD_START_OUT_OF_RANGE',
  productNotFound: 'AD_PRODUCT_NOT_FOUND',
  notCancellable: 'AD_PURCHASE_NOT_CANCELLABLE',
  purchaseNotFound: 'AD_PURCHASE_NOT_FOUND',
} as const;

/** GET /api/vendor/ads/products: the placements on sale and what this shop can spend on them. */
export function fetchVendorAdProducts(): Promise<VendorAdProductListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_AD_PRODUCTS_PATH,
    schema: vendorAdProductListResponseSchema,
  });
}

/** GET /api/vendor/ads/purchases: the shop's own purchases, newest first. */
export function fetchVendorAdPurchases(): Promise<AdPurchaseListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_AD_PURCHASES_PATH,
    schema: adPurchaseListResponseSchema,
  });
}

/**
 * POST /api/vendor/ads/purchases. The body carries the vendor's explicit agreement and one
 * idempotency key per purchase attempt: resending it never buys twice.
 */
export function purchaseVendorAd(
  request: Omit<AdPurchaseRequest, 'agreed'>,
): Promise<AdPurchaseResponseBody> {
  return apiRequest({
    method: 'POST',
    path: VENDOR_AD_PURCHASES_PATH,
    body: { ...request, agreed: true },
    schema: adPurchaseResponseSchema,
  });
}

/** POST /api/vendor/ads/purchases/:id/cancel: 200, also on repeat. */
export function cancelVendorAdPurchase(purchaseId: string): Promise<AdPurchaseCancelResponseBody> {
  return apiRequest({
    method: 'POST',
    path: `${VENDOR_AD_PURCHASES_PATH}/${purchaseId}/cancel`,
    schema: adPurchaseCancelResponseSchema,
  });
}

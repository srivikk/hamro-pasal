import {
  vendorOfferCreateRequestSchema,
  vendorOfferListResponseSchema,
  vendorOfferResponseSchema,
  type VendorOfferListResponseBody,
  type VendorOfferView,
} from '@hamro-pasal/shared-types';
import type { z } from 'zod';

import { ApiError, apiRequest } from './http';

export const VENDOR_OFFERS_PATH = '/api/vendor/offers';

/** Server codes the My Offers section words itself. */
export const OFFER_ERROR_CODES = {
  limitReached: 'OFFER_LIMIT_REACHED',
  notFound: 'OFFER_NOT_FOUND',
  endInPast: 'OFFER_END_IN_PAST',
  /** Client side: the offer broke the contract and was not sent. */
  invalid: 'INVALID_OFFER',
} as const;

export type VendorOfferDraft = z.input<typeof vendorOfferCreateRequestSchema>;

/** GET /api/vendor/offers: every offer of the shop, newest first, each with its derived status. */
export function fetchVendorOffers(): Promise<VendorOfferListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_OFFERS_PATH,
    schema: vendorOfferListResponseSchema,
  });
}

/**
 * POST /api/vendor/offers. The offer starts now and is never edited afterwards: the server takes
 * no start date. Checked with the API's own schema first; an offer that breaks it is not sent.
 */
export async function createVendorOffer(draft: VendorOfferDraft): Promise<VendorOfferView> {
  const body = vendorOfferCreateRequestSchema.safeParse(draft);
  if (!body.success) {
    throw new ApiError(400, OFFER_ERROR_CODES.invalid, body.error.message);
  }
  const { offer } = await apiRequest({
    method: 'POST',
    path: VENDOR_OFFERS_PATH,
    body: body.data,
    schema: vendorOfferResponseSchema,
  });
  return offer;
}

/** POST /api/vendor/offers/:id/end: 200, also on repeat. Orders already priced keep the offer. */
export async function endVendorOffer(offerId: string): Promise<VendorOfferView> {
  const { offer } = await apiRequest({
    method: 'POST',
    path: `${VENDOR_OFFERS_PATH}/${offerId}/end`,
    schema: vendorOfferResponseSchema,
  });
  return offer;
}

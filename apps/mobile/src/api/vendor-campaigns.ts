import {
  campaignOptInResponseSchema,
  vendorCampaignListResponseSchema,
  type CampaignOptInResponseBody,
  type VendorCampaignListResponseBody,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const VENDOR_CAMPAIGNS_PATH = '/api/vendor/campaigns';

/** Server codes the Campaigns section words itself. */
export const CAMPAIGN_ERROR_CODES = {
  termsChanged: 'CAMPAIGN_TERMS_CHANGED',
  notFound: 'CAMPAIGN_NOT_FOUND',
  ended: 'CAMPAIGN_ENDED',
  notOptedIn: 'CAMPAIGN_NOT_OPTED_IN',
} as const;

/** GET /api/vendor/campaigns: the invites open to the shop and the campaigns it joined. */
export function fetchVendorCampaigns(): Promise<VendorCampaignListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_CAMPAIGNS_PATH,
    schema: vendorCampaignListResponseSchema,
  });
}

/**
 * POST /api/vendor/campaigns/:id/opt-in. `termsVersion` is the version the vendor was shown: the
 * server refuses any other (409 CAMPAIGN_TERMS_CHANGED), so nobody joins terms they did not see.
 */
export function optInToCampaign(
  campaignId: string,
  termsVersion: number,
): Promise<CampaignOptInResponseBody> {
  return apiRequest({
    method: 'POST',
    path: `${VENDOR_CAMPAIGNS_PATH}/${campaignId}/opt-in`,
    body: { terms_version: termsVersion },
    schema: campaignOptInResponseSchema,
  });
}

/** POST /api/vendor/campaigns/:id/opt-out: 200, also on repeat. */
export function optOutOfCampaign(campaignId: string): Promise<CampaignOptInResponseBody> {
  return apiRequest({
    method: 'POST',
    path: `${VENDOR_CAMPAIGNS_PATH}/${campaignId}/opt-out`,
    schema: campaignOptInResponseSchema,
  });
}

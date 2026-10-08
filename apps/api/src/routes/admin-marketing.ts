import {
  adProductCreateRequestSchema,
  adProductUpdateRequestSchema,
  campaignWriteRequestSchema,
  idParamSchema,
  promotionWriteRequestSchema,
  type AdminAdProductListResponseBody,
  type AdminAdProductResponseBody,
  type AdminCampaignListResponseBody,
  type AdminCampaignResponseBody,
  type AdminCampaignView,
  type AdminPromotionListResponseBody,
  type AdminPromotionResponseBody,
  type AdminPromotionView,
  type AdProductView,
} from '@hamro-pasal/shared-types';
import type { Router } from 'express';

import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { AdProductRow, AdProductService } from '../marketing/ad-product-service';
import type { CampaignService, CampaignWithCount } from '../marketing/campaign-service';
import type { PromotionRow, PromotionService } from '../marketing/promotion-service';

export interface AdminMarketingServices {
  readonly campaigns: CampaignService;
  readonly adProducts: AdProductService;
  readonly promotions: PromotionService;
}

export function adminCampaignView({ campaign, optInCount }: CampaignWithCount): AdminCampaignView {
  return {
    id: campaign.id,
    name: campaign.name,
    kind: campaign.kind,
    value: campaign.value,
    max_discount_npr: campaign.max_discount_npr,
    min_cart_npr: campaign.min_cart_npr,
    vendor_share_percent: campaign.vendor_share_percent,
    terms_version: campaign.terms_version,
    starts_at: campaign.starts_at.toISOString(),
    ends_at: campaign.ends_at.toISOString(),
    is_active: campaign.is_active,
    opt_in_count: optInCount,
    created_at: campaign.created_at.toISOString(),
    updated_at: campaign.updated_at.toISOString(),
  };
}

export function adProductView(product: AdProductRow): AdProductView {
  return {
    id: product.id,
    name: product.name,
    slot: product.slot,
    billing_model: product.billing_model,
    price_npr: product.price_npr,
    duration_days: product.duration_days,
    is_active: product.is_active,
    // No vendor can buy an ad yet (`ad_purchases` arrives with the Ad Marketplace purchase flow).
    active_purchase_count: 0,
    created_at: product.created_at.toISOString(),
  };
}

export function adminPromotionView(promotion: PromotionRow): AdminPromotionView {
  return {
    id: promotion.id,
    placement: promotion.placement,
    image_url: promotion.image_url,
    title: promotion.title,
    subtitle: promotion.subtitle,
    target_type: promotion.target_type,
    target_value: promotion.target_value,
    display_order: promotion.display_order,
    is_active: promotion.is_active,
    starts_at: promotion.starts_at?.toISOString() ?? null,
    ends_at: promotion.ends_at?.toISOString() ?? null,
    is_sponsored: promotion.is_sponsored,
    ad_purchase_id: promotion.ad_purchase_id,
    created_at: promotion.created_at.toISOString(),
    updated_at: promotion.updated_at.toISOString(),
  };
}

/**
 * Phase 26: campaigns, the ad price list and the Home promotions, added to the /api/admin router
 * (behind requireAuth(SUPER_ADMIN), `no-store`).
 *
 * What is absent is the point: no route here enrols a shop in a campaign, names a vendor on an
 * ad product, or changes a published ad's terms.
 */
export function mountAdminMarketing(
  router: Router,
  { campaigns, adProducts, promotions }: AdminMarketingServices,
): void {
  router.get('/campaigns', async (_req, res) => {
    const body: AdminCampaignListResponseBody = {
      campaigns: (await campaigns.list()).map(adminCampaignView),
    };
    res.json(body);
  });

  router.post('/campaigns', async (req, res) => {
    const input = parseInput(campaignWriteRequestSchema, req.body);
    const body: AdminCampaignResponseBody = {
      campaign: adminCampaignView(
        await campaigns.create(authOf(req).userId, input, auditContextOf(req, res)),
      ),
    };
    res.status(201).json(body);
  });

  /**
   * Replaces every field. A changed term (the dates included) raises `terms_version` and voids
   * every live opt-in in the same transaction; the body cannot carry a version.
   */
  router.put('/campaigns/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(campaignWriteRequestSchema, req.body);
    const body: AdminCampaignResponseBody = {
      campaign: adminCampaignView(
        await campaigns.update(authOf(req).userId, id, input, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  router.get('/ads/products', async (_req, res) => {
    const body: AdminAdProductListResponseBody = {
      products: (await adProducts.list()).map(adProductView),
    };
    res.json(body);
  });

  router.post('/ads/products', async (req, res) => {
    const input = parseInput(adProductCreateRequestSchema, req.body);
    const body: AdminAdProductResponseBody = {
      product: adProductView(
        await adProducts.create(authOf(req).userId, input, auditContextOf(req, res)),
      ),
    };
    res.status(201).json(body);
  });

  /** The name and whether it is on sale. A placement, billing model, price or duration is a 400. */
  router.patch('/ads/products/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(adProductUpdateRequestSchema, req.body);
    const body: AdminAdProductResponseBody = {
      product: adProductView(
        await adProducts.update(authOf(req).userId, id, input, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  router.get('/promotions', async (_req, res) => {
    const body: AdminPromotionListResponseBody = {
      promotions: (await promotions.list()).map(adminPromotionView),
    };
    res.json(body);
  });

  router.post('/promotions', async (req, res) => {
    const input = parseInput(promotionWriteRequestSchema, req.body);
    const body: AdminPromotionResponseBody = {
      promotion: adminPromotionView(
        await promotions.create(authOf(req).userId, input, auditContextOf(req, res)),
      ),
    };
    res.status(201).json(body);
  });

  router.put('/promotions/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    const input = parseInput(promotionWriteRequestSchema, req.body);
    const body: AdminPromotionResponseBody = {
      promotion: adminPromotionView(
        await promotions.update(authOf(req).userId, id, input, auditContextOf(req, res)),
      ),
    };
    res.json(body);
  });

  router.delete('/promotions/:id', async (req, res) => {
    const { id } = parseInput(idParamSchema, { ...req.params });
    await promotions.remove(authOf(req).userId, id, auditContextOf(req, res));
    res.status(204).end();
  });
}

import {
  adProductCreateRequestSchema,
  adProductUpdateRequestSchema,
  campaignWriteRequestSchema,
  idParamSchema,
  MAX_PROMOTION_IMAGE_BYTES,
  PROMOTION_IMAGE_FILE_FIELD,
  promotionImageDeleteRequestSchema,
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
  type PromotionImageUploadResponseBody,
} from '@hamro-pasal/shared-types';
import type { Router } from 'express';

import { authOf } from '../http/auth';
import { auditContextOf } from '../http/request-context';
import { parseInput } from '../http/validate';
import type { AdProductRow, AdProductService } from '../marketing/ad-product-service';
import type { CampaignService, CampaignWithCount } from '../marketing/campaign-service';
import type { PromotionRow, PromotionService } from '../marketing/promotion-service';
import { missingFile, singleImageUpload, storedImageOf } from '../uploads/image-upload';
import type { PromotionImageStorage } from '../uploads/promotion-image-storage';

export interface AdminMarketingServices {
  readonly campaigns: CampaignService;
  readonly adProducts: AdProductService;
  readonly promotions: PromotionService;
  readonly promotionImages: PromotionImageStorage;
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

export function adProductView(product: AdProductRow, activePurchaseCount = 0): AdProductView {
  return {
    id: product.id,
    name: product.name,
    slot: product.slot,
    billing_model: product.billing_model,
    price_npr: product.price_npr,
    duration_days: product.duration_days,
    is_active: product.is_active,
    active_purchase_count: activePurchaseCount,
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
  { campaigns, adProducts, promotions, promotionImages }: AdminMarketingServices,
): void {
  const promotionImage = singleImageUpload(PROMOTION_IMAGE_FILE_FIELD, MAX_PROMOTION_IMAGE_BYTES);

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
    const counts = await adProducts.activePurchaseCounts();
    const body: AdminAdProductListResponseBody = {
      products: (await adProducts.list()).map((product) =>
        adProductView(product, counts.get(product.id) ?? 0),
      ),
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
        (await adProducts.activePurchaseCounts()).get(id) ?? 0,
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

  /**
   * Phase 34: multipart/form-data with one `image` part (JPEG, PNG or WebP by its own bytes, at
   * most 5 MB). The image is re-encoded (WebP, 1200 px, under 300 KB), stored in the public
   * bucket, and its absolute public URL returned, to be sent as a promotion's `image_url`.
   * Registered before `/promotions/:id` so "image" is never read as an id.
   */
  router.post('/promotions/image', promotionImage, async (req, res) => {
    const { file } = req;
    if (file === undefined) {
      throw missingFile(PROMOTION_IMAGE_FILE_FIELD, 'An image file is required');
    }
    const image = await storedImageOf(file.buffer, 'A promotion image');
    const body: PromotionImageUploadResponseBody = {
      url: await promotionImages.save(image.bytes, image.contentType),
    };
    res.status(201).json(body);
  });

  /**
   * An image that was uploaded and then not used (the form was cancelled, or another file was
   * chosen): deleted from the bucket. 409 while a promotion names it; a URL this API did not
   * issue is left alone. 204 also when it was already gone.
   */
  router.delete('/promotions/image', async (req, res) => {
    const { url } = parseInput(promotionImageDeleteRequestSchema, req.body);
    await promotions.discardImage(url);
    res.status(204).end();
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

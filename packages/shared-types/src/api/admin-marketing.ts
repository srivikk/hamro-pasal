import { z } from 'zod';

import { auditStateSchema } from '../audit/audit-log';
import {
  adBillingModelSchema,
  adSlotSchema,
  campaignOptInStatusSchema,
  discountKindSchema,
  promotionPlacementSchema,
  promotionTargetTypeSchema,
  type PromotionTargetType,
} from '../domain/enums';
import { CATEGORY_SLUG_REGEX, MAX_CATEGORY_SLUG_LENGTH } from '../domain/constants';

/*
 * Marketing contracts (Phase 26, SPEC core 7 and 8): platform campaigns and a shop's own opt-in,
 * the Ad Marketplace price list, and the Home promotions. The admin routes are served under
 * /api/admin to SUPER_ADMIN tokens only; the opt-in under /api/vendor to the shop's own account.
 */

// Campaigns -------------------------------------------------------------------------------

const campaignAmount = z.number().multipleOf(0.01).max(1_000_000);

/**
 * The body of POST /api/admin/campaigns and PUT /api/admin/campaigns/:id (PUT replaces every
 * field).
 *
 * Strict on purpose: there is no vendor, shop or opt-in key. A campaign applies to a shop only
 * through an opt-in row that shop's own account creates (SPEC core 7); an admin publishes the
 * campaign and nothing more. `terms_version` is not here either: the server starts it at 1 and
 * raises it itself when a term changes.
 */
export const campaignWriteRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    kind: discountKindSchema,
    /** NPR for FLAT; percent for PERCENTAGE. */
    value: campaignAmount.positive(),
    /** The most one order is discounted; PERCENTAGE only. */
    max_discount_npr: campaignAmount.positive().nullable(),
    min_cart_npr: campaignAmount.min(0),
    /** The share of each discount the vendor bears; the platform funds the rest. */
    vendor_share_percent: z.number().multipleOf(0.01).min(0).max(100),
    starts_at: z.iso.datetime(),
    ends_at: z.iso.datetime(),
    /** Published: shops see the invite. Unpublished: no shop sees it. */
    is_active: z.boolean(),
  })
  .refine((campaign) => campaign.kind !== 'PERCENTAGE' || campaign.value <= 100, {
    path: ['value'],
    message: 'A percentage is at most 100',
  })
  .refine((campaign) => campaign.kind === 'PERCENTAGE' || campaign.max_discount_npr === null, {
    path: ['max_discount_npr'],
    message: 'Only a percentage discount has a cap',
  })
  .refine((campaign) => campaign.ends_at > campaign.starts_at, {
    path: ['ends_at'],
    message: 'The campaign must end after it starts',
  });
export type CampaignWrite = z.infer<typeof campaignWriteRequestSchema>;

/** One campaign as GET /api/admin/campaigns lists it. */
export const adminCampaignViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  kind: discountKindSchema,
  value: z.number().positive(),
  max_discount_npr: z.number().positive().nullable(),
  min_cart_npr: z.number().min(0),
  vendor_share_percent: z.number().min(0).max(100),
  /** Raised by the server whenever a term a vendor agreed to changes. */
  terms_version: z.number().int().min(1),
  starts_at: z.iso.datetime(),
  ends_at: z.iso.datetime(),
  is_active: z.boolean(),
  /** Shops opted in to the current terms version. Read only: an admin cannot add to it. */
  opt_in_count: z.number().int().min(0),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type AdminCampaignView = z.infer<typeof adminCampaignViewSchema>;

export const adminCampaignListResponseSchema = z.strictObject({
  campaigns: z.array(adminCampaignViewSchema),
});
export type AdminCampaignListResponseBody = z.infer<typeof adminCampaignListResponseSchema>;

/** POST (201) and PUT (200) /api/admin/campaigns. */
export const adminCampaignResponseSchema = z.strictObject({ campaign: adminCampaignViewSchema });
export type AdminCampaignResponseBody = z.infer<typeof adminCampaignResponseSchema>;

/**
 * The body of POST /api/vendor/campaigns/:id/opt-in: the terms version the vendor was shown and
 * accepts. It must be the campaign's current one, or the answer is 409 CAMPAIGN_TERMS_CHANGED.
 */
export const campaignOptInRequestSchema = z.strictObject({
  terms_version: z.number().int().min(1),
});
export type CampaignOptInRequest = z.infer<typeof campaignOptInRequestSchema>;

/** A shop's consent to a campaign, with the terms exactly as they were accepted. */
export const campaignOptInViewSchema = z.strictObject({
  id: z.uuid(),
  campaign_id: z.uuid(),
  vendor_id: z.uuid(),
  opt_in_terms_version: z.number().int().min(1),
  terms: auditStateSchema,
  status: campaignOptInStatusSchema,
  opted_in_at: z.iso.datetime(),
});
export type CampaignOptInView = z.infer<typeof campaignOptInViewSchema>;

/** 201 for a new opt-in, 200 when the shop is already opted in to these terms. */
export const campaignOptInResponseSchema = z.strictObject({ opt_in: campaignOptInViewSchema });
export type CampaignOptInResponseBody = z.infer<typeof campaignOptInResponseSchema>;

// Ad products -----------------------------------------------------------------------------

const adProductName = z.string().trim().min(1).max(80);

/**
 * The body of POST /api/admin/ads/products. A price list entry, not a charge: an ad exists, and
 * a vendor is billed, only through a purchase the vendor's own account makes (SPEC core 8).
 * Nothing here names a vendor.
 */
export const adProductCreateRequestSchema = z.strictObject({
  name: adProductName,
  slot: adSlotSchema,
  billing_model: adBillingModelSchema,
  /**
   * NPR. FLAT_RATE: the price of the whole booked period. PER_ORDER_PREMIUM: the fixed fee for
   * each delivered order placed while the ad runs (a fixed fee, never a percentage).
   */
  price_npr: z.number().positive().multipleOf(0.01).max(1_000_000),
  /** How long one purchase runs. */
  duration_days: z.number().int().min(1).max(90),
  /** On sale in the Ad Marketplace. */
  is_active: z.boolean(),
});
export type AdProductCreate = z.infer<typeof adProductCreateRequestSchema>;

/**
 * The body of PATCH /api/admin/ads/products/:id. Strict on purpose: no placement, billing model,
 * price or duration, so any of them is a 400. Vendors agreed to those when they bought: a new
 * price is a new product, and the old one is taken off sale.
 */
export const adProductUpdateRequestSchema = z.strictObject({
  name: adProductName,
  is_active: z.boolean(),
});
export type AdProductUpdate = z.infer<typeof adProductUpdateRequestSchema>;

/** One product as GET /api/admin/ads/products lists it. */
export const adProductViewSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  slot: adSlotSchema,
  billing_model: adBillingModelSchema,
  price_npr: z.number().positive(),
  duration_days: z.number().int().min(1).max(90),
  is_active: z.boolean(),
  /** Purchases of this product that are running now. Read only: only a vendor can add one. */
  active_purchase_count: z.number().int().min(0),
  created_at: z.iso.datetime(),
});
export type AdProductView = z.infer<typeof adProductViewSchema>;

export const adminAdProductListResponseSchema = z.strictObject({
  products: z.array(adProductViewSchema),
});
export type AdminAdProductListResponseBody = z.infer<typeof adminAdProductListResponseSchema>;

/** POST (201) and PATCH (200) /api/admin/ads/products. */
export const adminAdProductResponseSchema = z.strictObject({ product: adProductViewSchema });
export type AdminAdProductResponseBody = z.infer<typeof adminAdProductResponseSchema>;

// Home promotions -------------------------------------------------------------------------

export const MAX_DISCOUNT_TAG_LENGTH = 40;
export const MAX_PROMOTION_DISPLAY_ORDER = 100_000;

/** What `target_value` must be for each target type: never a free-form id. */
export const PROMOTION_TARGET_VALUE_SCHEMAS: Readonly<
  Record<PromotionTargetType, z.ZodType<string>>
> = {
  /** The `vendors.id` of a LIVE shop. */
  SHOP: z.uuid(),
  /** The `categories.slug` of an active category, at any level. */
  CATEGORY: z.string().max(MAX_CATEGORY_SLUG_LENGTH).regex(CATEGORY_SLUG_REGEX),
  /** An offer label, matched without regard to case ("10% OFF"). */
  DISCOUNT_TAG: z.string().trim().min(1).max(MAX_DISCOUNT_TAG_LENGTH),
};

const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * The body of POST /api/admin/promotions and PUT /api/admin/promotions/:id (PUT replaces every
 * field).
 *
 * A promotion navigates or filters; it never changes a price. `is_sponsored` is true only
 * together with the ad purchase of the vendor who bought the placement (SPEC core 8): an admin
 * cannot mark a promotion as an ad, or charge for one, on their own.
 */
export const promotionWriteRequestSchema = z
  .strictObject({
    placement: promotionPlacementSchema,
    /** Required for CAROUSEL: a banner is its artwork. */
    image_url: httpUrl.nullable(),
    /** Required for FEATURED: an offer tile needs its text. */
    title: z.string().trim().min(1).max(60).nullable(),
    subtitle: z.string().trim().min(1).max(80).nullable(),
    /** Both null: the promotion is shown and is not tappable. */
    target_type: promotionTargetTypeSchema.nullable(),
    target_value: z.string().nullable(),
    display_order: z.number().int().min(0).max(MAX_PROMOTION_DISPLAY_ORDER),
    is_active: z.boolean(),
    /** Null: from now. */
    starts_at: z.iso.datetime().nullable(),
    /** Null: until it is switched off. */
    ends_at: z.iso.datetime().nullable(),
    is_sponsored: z.boolean(),
    ad_purchase_id: z.uuid().nullable(),
  })
  .refine((promotion) => promotion.placement !== 'CAROUSEL' || promotion.image_url !== null, {
    path: ['image_url'],
    message: 'A carousel banner needs its image',
  })
  .refine((promotion) => promotion.placement !== 'FEATURED' || promotion.title !== null, {
    path: ['title'],
    message: 'A featured offer needs a title',
  })
  .refine(
    (promotion) =>
      promotion.target_type === null
        ? promotion.target_value === null
        : promotion.target_value !== null &&
          PROMOTION_TARGET_VALUE_SCHEMAS[promotion.target_type].safeParse(promotion.target_value)
            .success,
    { path: ['target_value'], message: 'The target does not fit its type' },
  )
  .refine(
    (promotion) =>
      promotion.starts_at === null ||
      promotion.ends_at === null ||
      promotion.ends_at > promotion.starts_at,
    { path: ['ends_at'], message: 'The promotion must end after it starts' },
  )
  .refine((promotion) => promotion.is_sponsored === (promotion.ad_purchase_id !== null), {
    path: ['ad_purchase_id'],
    message: 'A promotion is sponsored exactly when it names the ad purchase',
  })
  .refine((promotion) => !promotion.is_sponsored || promotion.target_type === 'SHOP', {
    path: ['target_value'],
    message: 'A sponsored promotion targets the shop that bought it',
  });
export type PromotionWrite = z.infer<typeof promotionWriteRequestSchema>;

/** One promotion as GET /api/admin/promotions lists it: hidden and ended ones included. */
export const adminPromotionViewSchema = z.strictObject({
  id: z.uuid(),
  placement: promotionPlacementSchema,
  image_url: z.string().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  target_type: promotionTargetTypeSchema.nullable(),
  target_value: z.string().nullable(),
  display_order: z.number().int().min(0),
  is_active: z.boolean(),
  starts_at: z.iso.datetime().nullable(),
  ends_at: z.iso.datetime().nullable(),
  is_sponsored: z.boolean(),
  ad_purchase_id: z.uuid().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type AdminPromotionView = z.infer<typeof adminPromotionViewSchema>;

export const adminPromotionListResponseSchema = z.strictObject({
  promotions: z.array(adminPromotionViewSchema),
});
export type AdminPromotionListResponseBody = z.infer<typeof adminPromotionListResponseSchema>;

/** POST (201) and PUT (200) /api/admin/promotions. */
export const adminPromotionResponseSchema = z.strictObject({ promotion: adminPromotionViewSchema });
export type AdminPromotionResponseBody = z.infer<typeof adminPromotionResponseSchema>;

// The public read (Phase 28) --------------------------------------------------------------------

/**
 * One promotion as GET /api/home/promotions serves it to the customer app: what to draw and where
 * a tap leads. No dates, order or admin fields. `is_sponsored` draws the "Ad" badge.
 */
/**
 * POST /api/admin/promotions/image (multipart, one `image` part): the stored image's public URL,
 * to send as a promotion's `image_url`.
 */
export const promotionImageUploadResponseSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
});
export type PromotionImageUploadResponseBody = z.infer<typeof promotionImageUploadResponseSchema>;

/** DELETE /api/admin/promotions/image: an uploaded image that no promotion ended up using. */
export const promotionImageDeleteRequestSchema = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
});

export const homePromotionViewSchema = z.strictObject({
  id: z.uuid(),
  placement: promotionPlacementSchema,
  image_url: z.string().nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  target_type: promotionTargetTypeSchema.nullable(),
  target_value: z.string().nullable(),
  is_sponsored: z.boolean().default(false),
});
export type HomePromotionView = z.infer<typeof homePromotionViewSchema>;

/**
 * GET /api/home/promotions (public): the promotions running now, by `display_order`. `banners`
 * are the CAROUSEL ones, `offers` the FEATURED tiles. Two empty lists is a normal answer.
 */
export const homePromotionsResponseSchema = z.strictObject({
  banners: z.array(homePromotionViewSchema),
  offers: z.array(homePromotionViewSchema),
});
export type HomePromotionsResponseBody = z.infer<typeof homePromotionsResponseSchema>;

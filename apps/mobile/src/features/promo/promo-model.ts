/**
 * The shapes the customer app needs for admin promotions and for the visual parts of a shop
 * (cover, rating, offer, preparation time, cost). None of them is served by the API yet: field
 * names are the ones proposed for it (STATE_HANDOFF §8Z.3, §8Z.4), so replacing the mock source in
 * mock-promotions.ts with real responses changes no component.
 */

/**
 * Where a promotion leads when it is tapped. The admin chooses one when creating it:
 * - SHOP: `target_value` is a vendor id; the shop's page opens.
 * - CATEGORY: `target_value` is a category slug ("festive"); Home is filtered to that category,
 *   exactly as if its tile had been tapped.
 * - DISCOUNT_TAG: `target_value` is an offer label ("10% OFF"); Home is filtered to the shops
 *   that carry that label.
 *
 * Phase 1: promotions are visual and navigational only. No target changes a price, and no
 * discount exists at checkout.
 */
export const PROMO_TARGET_TYPES = ['SHOP', 'DISCOUNT_TAG', 'CATEGORY'] as const;
export type PromoTargetType = (typeof PROMO_TARGET_TYPES)[number];

/** CAROUSEL: a slide of the large banner carousel. FEATURED: a tile of "Featured offers". */
export type PromoPlacement = 'CAROUSEL' | 'FEATURED';

/** One promotion as the API will list it. */
export interface Promotion {
  id: string;
  placement: PromoPlacement;
  /** Required for a CAROUSEL banner (it is its artwork); optional for a FEATURED tile. */
  image_url: string | null;
  /** Required for a FEATURED tile; optional on a banner whose artwork carries its own text. */
  title: string | null;
  subtitle: string | null;
  /** Both null for a promotion that is only shown; otherwise both set. */
  target_type: PromoTargetType | null;
  target_value: string | null;
  /** A vendor paid for this placement: it carries the "Ad" label (SPEC core 8). */
  is_sponsored?: boolean;
}

export type PromoBanner = Promotion & { placement: 'CAROUSEL'; image_url: string };
export type FeaturedOffer = Promotion & { placement: 'FEATURED'; title: string };

/** A promotion's destination, ready to act on. */
export interface PromoTarget {
  type: PromoTargetType;
  value: string;
}

/** Null when the promotion leads nowhere (no type, or a blank value). */
export function promoTarget(promotion: Promotion): PromoTarget | null {
  const value = promotion.target_value?.trim() ?? '';
  if (promotion.target_type === null || value === '') return null;
  return { type: promotion.target_type, value };
}

export interface HomePromotions {
  banners: PromoBanner[];
  offers: FeaturedOffer[];
}

export const NO_PROMOTIONS: HomePromotions = { banners: [], offers: [] };

/** What the feed and the menu do not say about a shop yet. Every field may be unknown. */
export interface VendorExtras {
  cover_image_url: string | null;
  /** Average of the published customer ratings, 1–5. */
  rating_average: number | null;
  /** How many published ratings the average is made of. Null with no rating. */
  rating_count: number | null;
  /** The neighbourhood the shop is in (its Tole), shown before its Palika. */
  locality: string | null;
  /** Minutes the shop usually needs before an order leaves. */
  prep_minutes: number | null;
  /** A typical basket at this shop, in NPR: what "Cost" sorts by. */
  average_cost_npr: number | null;
  /** The shop's best running offer, as one short line ("20% OFF up to Rs. 100"). */
  top_offer: string | null;
  /** Every offer label the shop carries: what a DISCOUNT_TAG promotion filters by. */
  offer_tags: string[];
  /** The shop paid for this listing (an active ad purchase): it must be labelled as an ad. */
  is_sponsored: boolean;
}

export const NO_VENDOR_EXTRAS: VendorExtras = {
  cover_image_url: null,
  rating_average: null,
  rating_count: null,
  locality: null,
  prep_minutes: null,
  average_cost_npr: null,
  top_offer: null,
  offer_tags: [],
  is_sponsored: false,
};

/**
 * A rating count as shops show it: exact below ten, otherwise rounded down with a plus
 * (95 → "90+", 320 → "300+", 1250 → "1000+").
 */
export function ratingCountDisplay(count: number): { shown: number; plus: boolean } {
  if (count < 10) return { shown: Math.max(0, Math.floor(count)), plus: false };
  const step = count < 100 ? 10 : count < 1000 ? 100 : 1000;
  return { shown: Math.floor(count / step) * step, plus: true };
}

/** The shop a set of extras is asked for: its name too, because the mocks are keyed by it. */
export interface ExtrasSubject {
  id: string;
  business_name: string;
  /** 2026-10-21: the server's rating of the shop, when the caller has it (feed, menu). */
  rating_average?: number | null;
  rating_count?: number;
}

/** Labels are compared without regard to case or surrounding spaces ("10% off" = "10% OFF"). */
export function hasOfferTag(extras: VendorExtras, tag: string): boolean {
  const wanted = tag.trim().toLowerCase();
  return extras.offer_tags.some((label) => label.trim().toLowerCase() === wanted);
}

/** Minutes a rider needs per kilometre in city traffic: a display estimate, not a promise. */
const TRAVEL_MINUTES_PER_KM = 3;
const WINDOW_STEP_MINUTES = 5;
const WINDOW_WIDTH_MINUTES = 10;

/** Preparation plus travel, in minutes. Null while the preparation time is unknown. */
export function estimatedDeliveryMinutes(
  prepMinutes: number | null,
  distanceKm: number,
): number | null {
  if (prepMinutes === null) return null;
  return prepMinutes + Math.ceil(distanceKm * TRAVEL_MINUTES_PER_KM);
}

/** The estimate as the "40–50 mins" range shown on a card: rounded up to 5, ten minutes wide. */
export function deliveryWindow(
  prepMinutes: number | null,
  distanceKm: number,
): { min: number; max: number } | null {
  const estimate = estimatedDeliveryMinutes(prepMinutes, distanceKm);
  if (estimate === null) return null;
  const min = Math.ceil(estimate / WINDOW_STEP_MINUTES) * WINDOW_STEP_MINUTES;
  return { min, max: min + WINDOW_WIDTH_MINUTES };
}

import type { DeliveryScope, GeoPoint, VendorFulfillmentMode } from '@hamro-pasal/shared-types';

import { paisaOf, timesPaisa } from './decimal-money';

const EARTH_RADIUS_KM = 6371.0088;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance between two points (`x` = longitude, `y` = latitude), in kilometres. */
export function haversineKm(from: GeoPoint, to: GeoPoint): number {
  const dLat = toRadians(to.y - from.y);
  const dLng = toRadians(to.x - from.x);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.y)) * Math.cos(toRadians(to.y)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** What decides a delivery charge: the shop's settings and the platform's. */
export interface DeliveryTerms {
  readonly fulfillmentMode: VendorFulfillmentMode;
  readonly deliveryScope: DeliveryScope;
  readonly baseFeeNpr: number;
  readonly perKmFeeNpr: number;
  /** The shop's own free-delivery threshold (SELF_DELIVERY only); the shop funds it. */
  readonly freeAboveNpr: number | null;
  /** The Super Admin's charge for a platform fleet delivery. */
  readonly platformFeeNpr: number;
  /**
   * The platform's free-delivery threshold (2026-10-21), for every shop; the platform funds it.
   * Null: switched off.
   */
  readonly platformFreeAboveNpr: number | null;
}

/** Who pays for a delivery the customer does not pay for. */
export type FreeDeliveryFunder = 'SHOP' | 'PLATFORM';

export interface DeliveryCharge {
  /** What the customer pays for delivery. */
  readonly feePaisa: number;
  /**
   * What the platform pays instead of the customer: the whole fee when its own threshold made
   * delivery free, else 0. Whoever delivers (the shop, or the platform rider) earns it all the
   * same at settlement.
   */
  readonly subsidyPaisa: number;
  /** Why the customer pays nothing for delivery; null when they pay the fee. */
  readonly freeBy: FreeDeliveryFunder | null;
}

/**
 * The delivery charge of an order (SPEC Dual-Fulfillment, "Delivery charge", and core 9). Pure:
 * the quote and checkout both call it, so they cannot disagree.
 *
 * `goodsPaisa` is what the customer pays for the goods: the subtotal after the vendor offer and
 * the campaign discount (decided 2026-10-21: discounts apply before any delivery threshold).
 *
 *   the fee        PLATFORM_FLEET: the platform's fee; the shop's own charges never apply.
 *                  SELF_DELIVERY: base fee + per-km fee x started kilometres (RADIUS_BOUND only:
 *                  a per-km charge on a city-wide or national shop would be unbounded).
 *   shop threshold SELF_DELIVERY, goods at or above it: free, funded by the shop (it forgoes its
 *                  own fee; it chose the threshold).
 *   platform       otherwise, goods at or above it: free, funded by the platform, which pays the
 *   threshold      fee to whoever delivers. A shop is never charged for a threshold it did not
 *                  set itself (SPEC core 7, "Principle").
 */
export function deliveryCharge(
  terms: DeliveryTerms,
  goodsPaisa: number,
  distanceKm: number,
): DeliveryCharge {
  const selfDelivered = terms.fulfillmentMode === 'SELF_DELIVERY';
  const reaches = (threshold: number | null): boolean =>
    threshold !== null && goodsPaisa >= paisaOf(threshold);

  if (selfDelivered && reaches(terms.freeAboveNpr)) {
    return { feePaisa: 0, subsidyPaisa: 0, freeBy: 'SHOP' };
  }
  const feePaisa = selfDelivered
    ? paisaOf(terms.baseFeeNpr) +
      (terms.deliveryScope === 'RADIUS_BOUND'
        ? timesPaisa(terms.perKmFeeNpr, Math.ceil(Math.max(0, distanceKm)))
        : 0)
    : paisaOf(terms.platformFeeNpr);
  if (feePaisa > 0 && reaches(terms.platformFreeAboveNpr)) {
    return { feePaisa: 0, subsidyPaisa: feePaisa, freeBy: 'PLATFORM' };
  }
  return { feePaisa, subsidyPaisa: 0, freeBy: null };
}

/**
 * The lowest free-delivery threshold that applies to a shop, in NPR, for the shop page and the
 * cart's "Rs. X more for free delivery"; null when none does.
 */
export function freeDeliveryThresholdNpr(
  terms: Pick<DeliveryTerms, 'fulfillmentMode' | 'freeAboveNpr' | 'platformFreeAboveNpr'>,
): number | null {
  const thresholds = [
    terms.fulfillmentMode === 'SELF_DELIVERY' ? terms.freeAboveNpr : null,
    terms.platformFreeAboveNpr,
  ].filter((threshold): threshold is number => threshold !== null);
  return thresholds.length === 0
    ? null
    : thresholds.reduce((low, threshold) => (paisaOf(threshold) < paisaOf(low) ? threshold : low));
}

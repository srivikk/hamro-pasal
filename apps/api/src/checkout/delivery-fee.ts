import type { DeliveryScope, GeoPoint, VendorFulfillmentMode } from '@hamro-pasal/shared-types';

import { toPaisa } from '../ledger/money';

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

/** What decides a delivery charge: the shop's settings and the platform's fleet fee. */
export interface DeliveryTerms {
  readonly fulfillmentMode: VendorFulfillmentMode;
  readonly deliveryScope: DeliveryScope;
  readonly baseFeeNpr: number;
  readonly perKmFeeNpr: number;
  readonly freeAboveNpr: number | null;
  /** The Super Admin's charge for a platform fleet delivery. */
  readonly platformFeeNpr: number;
}

/**
 * The delivery charge of an order, in paisa (SPEC Dual-Fulfillment, "Delivery charge"). Pure: the
 * quote and checkout both call it, so they cannot disagree.
 *
 *   PLATFORM_FLEET  the platform's fee; the shop's own charges never apply
 *   SELF_DELIVERY   0 when the subtotal reaches the shop's free-delivery threshold, otherwise
 *                   base fee + per-km fee x kilometres (started kilometres, RADIUS_BOUND only:
 *                   a per-km charge on a city-wide or national shop would be unbounded)
 */
export function deliveryFeePaisa(
  terms: DeliveryTerms,
  subtotalPaisa: number,
  distanceKm: number,
): number {
  if (terms.fulfillmentMode === 'PLATFORM_FLEET') return toPaisa(terms.platformFeeNpr);
  if (terms.freeAboveNpr !== null && subtotalPaisa >= toPaisa(terms.freeAboveNpr)) return 0;
  const perKm =
    terms.deliveryScope === 'RADIUS_BOUND'
      ? toPaisa(terms.perKmFeeNpr) * Math.ceil(Math.max(0, distanceKm))
      : 0;
  return toPaisa(terms.baseFeeNpr) + perKm;
}

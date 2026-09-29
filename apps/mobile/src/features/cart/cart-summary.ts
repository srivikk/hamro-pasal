import { toNpr, toPaisa } from '../../lib/money';
import type { CartLine, CartVendor } from '../../store/useCartStore';

/**
 * The customer pays no platform fee. SPEC §4: the platform's commission is deducted from the
 * vendor's payout at settlement (0% on SUBSCRIPTION), and the checkout API charges exactly
 * subtotal + delivery fee (`total_npr`). The row is shown so the customer sees the fee is zero.
 */
export const CUSTOMER_PLATFORM_FEE_NPR = 0;

export interface CartSummary {
  subtotalNpr: number;
  deliveryFeeNpr: number;
  platformFeeNpr: number;
  totalNpr: number;
  /** How far the subtotal is below the vendor's MOV; 0 when checkout is allowed (SPEC step 5). */
  shortOfMinimumNpr: number;
}

/**
 * Client-side estimate of what the server will charge. Display only: the server re-prices every
 * line from the database, and its `total_npr` is authoritative.
 */
export function computeCartSummary(vendor: CartVendor, lines: readonly CartLine[]): CartSummary {
  const subtotal = lines.reduce((sum, line) => sum + toPaisa(line.unitPriceNpr) * line.quantity, 0);
  const deliveryFee = toPaisa(vendor.deliveryFeeNpr);
  const platformFee = toPaisa(CUSTOMER_PLATFORM_FEE_NPR);
  const minimum = toPaisa(vendor.minOrderValueNpr);
  return {
    subtotalNpr: toNpr(subtotal),
    deliveryFeeNpr: toNpr(deliveryFee),
    platformFeeNpr: toNpr(platformFee),
    totalNpr: toNpr(subtotal + deliveryFee + platformFee),
    shortOfMinimumNpr: toNpr(Math.max(0, minimum - subtotal)),
  };
}

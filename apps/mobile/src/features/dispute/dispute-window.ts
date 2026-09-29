import type { OrderState } from '@hamro-pasal/shared-types';

/**
 * SPEC customer flow step 11: a 48 h window opens at delivery for the double-blind review and for
 * opening a dispute (SPEC §6: reviews publish when both sides rate or 48 hours elapse).
 */
export const POST_DELIVERY_WINDOW_MS = 48 * 60 * 60 * 1000;

/** When the 48 h window closes, or null if the delivery time is unknown on this device. */
export function postDeliveryDeadline(deliveredAtMs: number | null): number | null {
  return deliveredAtMs === null ? null : deliveredAtMs + POST_DELIVERY_WINDOW_MS;
}

/** A dispute can be opened for a DELIVERED order strictly before 48 h have passed. */
export function isDisputeEligible(
  state: OrderState,
  deliveredAtMs: number | null,
  nowMs: number,
): boolean {
  const deadline = postDeliveryDeadline(deliveredAtMs);
  return state === 'DELIVERED' && deadline !== null && nowMs < deadline;
}

import type { TrackedOrder } from '../../store/useOrderStore';
import type { ReviewStoreState } from '../../store/useReviewStore';
import { postDeliveryDeadline } from '../dispute/dispute-window';

/**
 * The delivered order to ask a review for, if any: DELIVERED, inside the 48 h window, not yet
 * reviewed on this device and not put off this session. The most recent delivery comes first.
 */
export function orderAwaitingReview(
  orders: Readonly<Record<string, TrackedOrder>>,
  reviews: Pick<ReviewStoreState, 'submitted' | 'snoozed'>,
  nowMs: number,
): TrackedOrder | null {
  const candidates = Object.values(orders).filter((order) => {
    const deadline = postDeliveryDeadline(order.deliveredAt);
    return (
      order.state === 'DELIVERED' &&
      deadline !== null &&
      nowMs < deadline &&
      reviews.submitted[order.orderId] === undefined &&
      reviews.snoozed[order.orderId] === undefined
    );
  });
  candidates.sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0));
  return candidates[0] ?? null;
}

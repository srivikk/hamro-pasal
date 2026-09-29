import { useState } from 'react';

import { ReviewModal } from '../../components/ReviewModal';
import { useOrderStore } from '../../store/useOrderStore';
import { useReviewStore } from '../../store/useReviewStore';
import { orderAwaitingReview } from './review-prompt';

/**
 * Mounted once at the root: opens the review modal as soon as a tracked order is DELIVERED and
 * not yet reviewed, whichever screen is showing. Submitting (persisted) or "Not now" (this
 * session only) updates the review store, which is what closes the modal.
 */
export function ReviewPrompt() {
  const orders = useOrderStore((state) => state.orders);
  const submitted = useReviewStore((state) => state.submitted);
  const snoozed = useReviewStore((state) => state.snoozed);
  // The launch time is precise enough for a 48 h window, and keeps the render pure.
  const [now] = useState(() => Date.now());

  const order = orderAwaitingReview(orders, { submitted, snoozed }, now);

  return <ReviewModal orderId={order?.orderId ?? null} onDone={() => undefined} />;
}

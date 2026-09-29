import { ApiError } from '../../api/http';
import { CANCELLATION_WINDOW_MS } from './cancellation-window';

/*
 * MOCK cancellation API. The backend has no cancel endpoint (STATE_HANDOFF §8), so this stands in
 * for `POST /api/orders/:id/cancel` until one exists. It changes NOTHING on the server: the order
 * stays PLACED there, the vendor still receives it, and a prepaid order is not refunded. Replace
 * `cancelOrder` with a real apiRequest once the endpoint (with its server-side 60 s check and the
 * SPEC gateway refund) is built.
 */

/** POST /api/orders/:id/cancel answers 422 with this code once the 60 s window has closed. */
export const CANCELLATION_WINDOW_EXPIRED = 'CANCELLATION_WINDOW_EXPIRED';

export interface CancelOrderResult {
  order_id: string;
  state: 'CANCELED';
}

export async function cancelOrder(
  orderId: string,
  placedAtMs: number,
  { latencyMs = 300, nowMs = () => Date.now() }: { latencyMs?: number; nowMs?: () => number } = {},
): Promise<CancelOrderResult> {
  await new Promise((resolve) => setTimeout(resolve, latencyMs));
  // The server would enforce the window too; the client-side check alone is never enough.
  if (nowMs() > placedAtMs + CANCELLATION_WINDOW_MS) {
    throw new ApiError(422, CANCELLATION_WINDOW_EXPIRED, 'The 60 s cancellation window has ended');
  }
  return { order_id: orderId, state: 'CANCELED' };
}

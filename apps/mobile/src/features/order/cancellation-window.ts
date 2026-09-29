import type { OrderState } from '@hamro-pasal/shared-types';

/** SPEC customer flow step 8: an unskippable 60-second cancellation window starts post-order. */
export const CANCELLATION_WINDOW_MS = 60_000;

/**
 * Time left to cancel, from when the app saw the order become PLACED. Clamped to [0, 60 s]: a
 * device clock moved backwards can never stretch the window past 60 s.
 */
export function cancellationRemainingMs(placedAtMs: number | null, nowMs: number): number {
  if (placedAtMs === null) return 0;
  return Math.min(CANCELLATION_WINDOW_MS, Math.max(0, placedAtMs + CANCELLATION_WINDOW_MS - nowMs));
}

/** Cancellation is offered only for a PLACED order inside its window. */
export function canCancel(state: OrderState, placedAtMs: number | null, nowMs: number): boolean {
  return state === 'PLACED' && cancellationRemainingMs(placedAtMs, nowMs) > 0;
}

/**
 * The state the tracker shows. Once the window has closed, a still-PLACED order is shown as
 * PREPARING (the window's end is when the vendor starts on it). Every server state that is further
 * along wins as-is. This only changes the display: the server state is never rewritten.
 */
export function displayedOrderState(state: OrderState, windowOpen: boolean): OrderState {
  return state === 'PLACED' && !windowOpen ? 'PREPARING' : state;
}

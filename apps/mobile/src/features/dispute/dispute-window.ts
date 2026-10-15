import type { OrderState } from '@hamro-pasal/shared-types';

/**
 * SPEC customer flow step 11: a 48 h window opens at delivery for the double-blind review (SPEC §6:
 * reviews publish when both sides rate or 48 hours elapse).
 */
export const POST_DELIVERY_WINDOW_MS = 48 * 60 * 60 * 1000;

/** When the 48 h window closes, or null if the delivery time is unknown on this device. */
export function postDeliveryDeadline(deliveredAtMs: number | null): number | null {
  return deliveredAtMs === null ? null : deliveredAtMs + POST_DELIVERY_WINDOW_MS;
}

/**
 * Step 7.3 (SPEC core 6): the order conversation with the shop is open from placement until
 * 7 days (168 h) after delivery, and stays open while it is escalated (DISPUTED).
 */
export const CONVERSATION_WINDOW_MS = 168 * 60 * 60 * 1000;

/** When the conversation closes, or null before delivery (or without a known delivery time). */
export function conversationDeadline(deliveredAtMs: number | null): number | null {
  return deliveredAtMs === null ? null : deliveredAtMs + CONVERSATION_WINDOW_MS;
}

const CONVERSATION_STATES: ReadonlySet<OrderState> = new Set([
  'PLACED',
  'PREPARING',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DISPUTED',
]);

/**
 * Whether the device offers the conversation: an escalated order always; a placed order until its
 * delivery; a delivered one while `beforeDeadline` (7 days after delivery). Never for an unpaid,
 * cancelled or failed order. A delivered order whose delivery time this device never saw is left
 * to the server (not offered).
 */
export function isConversationOpen(
  state: OrderState,
  deliveredAtMs: number | null,
  beforeDeadline: boolean,
): boolean {
  if (state === 'DISPUTED') return true;
  if (!CONVERSATION_STATES.has(state)) return false;
  if (state === 'DELIVERED') return deliveredAtMs !== null && beforeDeadline;
  return true;
}

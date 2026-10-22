import { useLocalSearchParams } from 'expo-router';

import { DisputeChat } from '../../src/features/dispute/DisputeChat';

/**
 * 2026-10-21 (Task 5, SPEC core 6): the shop's side of an order's conversation, opened from its
 * card on Live Orders. The customer, the shop and (once escalated) Hamro Pasal write here. The
 * server decides whether it is open (from placement until 7 days after delivery, and while
 * escalated); the screen shows its refusal. The shop escalates under /api/vendors/orders and
 * sends no photos (evidence uploads are the customer's).
 */
export default function VendorOrderChatScreen() {
  const { id, escalated } = useLocalSearchParams<{ id: string; escalated?: string }>();
  return <DisputeChat orderId={id} escalated={escalated === '1'} party="VENDOR" />;
}

import { escalationResponseSchema, type ConversationView } from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';

import { apiRequest } from '../../api/http';

/** Who writes in the conversation: the order's customer, or its shop (Seller app). */
export type ChatParty = 'CUSTOMER' | 'VENDOR';

/** The customer escalates under /api/orders, the shop under /api/vendors/orders. */
export function escalationPath(orderId: string, party: ChatParty = 'CUSTOMER'): string {
  return party === 'VENDOR'
    ? `/api/vendors/orders/${orderId}/escalate`
    : `/api/orders/${orderId}/escalate`;
}

/** POST …/:id/escalate (step 7.3): either party asks Hamro Pasal to decide, once per order. */
export function escalateOrder(
  orderId: string,
  reason: string,
  party: ChatParty = 'CUSTOMER',
): Promise<ConversationView> {
  return apiRequest({
    method: 'POST',
    path: escalationPath(orderId, party),
    body: { reason },
    schema: escalationResponseSchema,
  }).then((body) => body.conversation);
}

export function useEscalation(orderId: string, party: ChatParty = 'CUSTOMER') {
  return useMutation({
    mutationFn: (reason: string) => escalateOrder(orderId, reason, party),
    retry: false,
  });
}

import { escalationResponseSchema, type ConversationView } from '@hamro-pasal/shared-types';
import { useMutation } from '@tanstack/react-query';

import { apiRequest } from '../../api/http';

export function escalationPath(orderId: string): string {
  return `/api/orders/${orderId}/escalate`;
}

/** POST /api/orders/:id/escalate (step 7.3): the customer asks Hamro Pasal to decide, once. */
export function escalateOrder(orderId: string, reason: string): Promise<ConversationView> {
  return apiRequest({
    method: 'POST',
    path: escalationPath(orderId),
    body: { reason },
    schema: escalationResponseSchema,
  }).then((body) => body.conversation);
}

export function useEscalation(orderId: string) {
  return useMutation({
    mutationFn: (reason: string) => escalateOrder(orderId, reason),
    retry: false,
  });
}

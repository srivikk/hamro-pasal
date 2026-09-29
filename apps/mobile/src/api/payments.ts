import {
  esewaInitiateResponseSchema,
  khaltiInitiateResponseSchema,
  paymentStatusResponseSchema,
  type EsewaInitiateResponseBody,
  type KhaltiInitiateResponseBody,
  type PaymentStatusResponseBody,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const ESEWA_INITIATE_PATH = '/api/payments/esewa/initiate';
export const ESEWA_WEBHOOK_PATH = '/api/payments/esewa/webhook';
export const KHALTI_INITIATE_PATH = '/api/payments/khalti/initiate';
export const KHALTI_LOOKUP_PATH = '/api/payments/khalti/lookup';

/** Signs an eSewa ePay v2 request for the order (HMAC-SHA256, Base64; computed on the server). */
export function initiateEsewa(orderId: string): Promise<EsewaInitiateResponseBody> {
  return apiRequest({
    method: 'POST',
    path: ESEWA_INITIATE_PATH,
    body: { order_id: orderId },
    schema: esewaInitiateResponseSchema,
  });
}

/**
 * Forwards eSewa's success-redirect `data` untouched. The server verifies its signature, the
 * COMPLETE status and the amount before crediting escrow (SPEC eSewa validation).
 */
export function confirmEsewa(data: string): Promise<PaymentStatusResponseBody> {
  return apiRequest({
    method: 'POST',
    path: ESEWA_WEBHOOK_PATH,
    body: { data },
    schema: paymentStatusResponseSchema,
  });
}

export function initiateKhalti(orderId: string): Promise<KhaltiInitiateResponseBody> {
  return apiRequest({
    method: 'POST',
    path: KHALTI_INITIATE_PATH,
    body: { order_id: orderId },
    schema: khaltiInitiateResponseSchema,
  });
}

/** The server looks the pidx up with Khalti; only `Completed` credits escrow (SPEC Khalti verify). */
export function lookupKhalti(pidx: string): Promise<PaymentStatusResponseBody> {
  return apiRequest({
    method: 'POST',
    path: KHALTI_LOOKUP_PATH,
    body: { pidx },
    schema: paymentStatusResponseSchema,
  });
}

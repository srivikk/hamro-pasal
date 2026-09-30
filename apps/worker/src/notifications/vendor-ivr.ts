import type { IvrCall } from '@hamro-pasal/ivr';
import type { DomainEvent } from '@hamro-pasal/shared-types';

import { orderCode } from './vendor-sms';

/**
 * The voice call for a 90 s escalation (vendor flow step 6: "automated IVR/SMS alert"), placed
 * together with the SMS. The order code is spelled out one character at a time so the
 * text-to-speech voice reads it the way the dashboard shows it. Null for every other event.
 */
export function vendorEscalationCall(event: DomainEvent): IvrCall | null {
  if (event.event_type !== 'vendor.escalation.required') return null;
  const { vendor_phone, order_id, sla_seconds } = event.payload;
  return {
    to: vendor_phone,
    script:
      `You have a pending order on Hamro Pasal. Order ${orderCode(order_id).split('').join(' ')} ` +
      `has waited over ${String(sla_seconds)} seconds. Open the app now to accept or reject it.`,
  };
}

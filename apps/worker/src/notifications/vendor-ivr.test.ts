import { randomUUID } from 'node:crypto';

import { MAX_IVR_SCRIPT_LENGTH, prepareOutboundCall } from '@hamro-pasal/ivr';
import type { DomainEvent } from '@hamro-pasal/shared-types';

import { vendorEscalationCall } from './vendor-ivr';

const AT = '2026-09-30T10:00:00.000Z';
const PHONE = '+9779800000011';

function escalation(orderId: string, slaSeconds = 90): DomainEvent {
  return {
    event_id: randomUUID(),
    event_version: 1,
    occurred_at: AT,
    event_type: 'vendor.escalation.required',
    aggregate_id: orderId,
    payload: {
      order_id: orderId,
      vendor_id: randomUUID(),
      vendor_phone: PHONE,
      placed_at: AT,
      sla_seconds: slaSeconds,
      escalated_at: AT,
    },
  };
}

describe('vendorEscalationCall', () => {
  it('reads the order code one character at a time, with the SLA from the event', () => {
    expect(vendorEscalationCall(escalation('a1b2c3d4-0000-4000-8000-0000004fa5b6'))).toEqual({
      to: PHONE,
      script:
        'You have a pending order on Hamro Pasal. Order 4 F A 5 B 6 has waited over 90 seconds. ' +
        'Open the app now to accept or reject it.',
    });
    expect(vendorEscalationCall(escalation(randomUUID(), 120))?.script).toContain(
      'over 120 seconds',
    );
  });

  it('fits the IVR script limit and passes the +977 check', () => {
    const call = vendorEscalationCall(escalation(randomUUID()));
    if (call === null) throw new Error('no call');
    expect(call.script.length).toBeLessThanOrEqual(MAX_IVR_SCRIPT_LENGTH);
    expect(prepareOutboundCall(call).to).toBe(PHONE);
  });

  it('is null for every other event', () => {
    const vendorId = randomUUID();
    expect(
      vendorEscalationCall({
        event_id: randomUUID(),
        event_version: 1,
        occurred_at: AT,
        event_type: 'vendor.restored',
        aggregate_id: vendorId,
        payload: {
          vendor_id: vendorId,
          vendor_phone: PHONE,
          restored_status: 'LIVE',
          wallet_balance_npr: 0,
          transaction_id: randomUUID(),
          restored_at: AT,
        },
      }),
    ).toBeNull();
  });
});

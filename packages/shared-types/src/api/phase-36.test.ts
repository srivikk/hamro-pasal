import { AUDIT_ACTION_ENTITY_TYPES } from '../audit/audit-log';
import { vendorStatusSchema } from '../domain/enums';
import { DOMAIN_EVENT_TOPICS, domainEventSchema } from '../events/domain-events';
import {
  vendorDeactivateRequestSchema,
  vendorDeactivateResponseSchema,
  vendorDeactivationBlockers,
} from './vendor-account';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-09T06:15:00.000Z';

const restored = {
  event_id: '44444444-4444-4444-8444-444444444444',
  event_type: 'vendor.compliance_restored',
  event_version: 1,
  occurred_at: AT,
  aggregate_id: VENDOR_ID,
  payload: {
    vendor_id: VENDOR_ID,
    vendor_phone: '+9779800000011',
    status: 'LIVE',
    waiting_invoices_issued: 2,
    restored_at: AT,
  },
};

describe('vendor deactivation (Phase 36)', () => {
  it('is a vendor status, audited on the vendor', () => {
    expect(vendorStatusSchema.safeParse('DEACTIVATED').success).toBe(true);
    expect(AUDIT_ACTION_ENTITY_TYPES.VENDOR_DEACTIVATED).toBe('vendor');
  });

  it('needs the explicit confirmation and takes nothing else', () => {
    expect(vendorDeactivateRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    for (const body of [
      {},
      { confirm: false },
      { confirm: 'true' },
      { confirm: true, vendor_id: VENDOR_ID },
      { confirm: true, status: 'DEACTIVATED' },
    ]) {
      expect(vendorDeactivateRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it('answers what was closed with the shop and what the platform still holds for it', () => {
    const body = {
      vendor_id: VENDOR_ID,
      status: 'DEACTIVATED',
      deactivated_at: AT,
      cancelled_ad_count: 2,
      returned_npr: 200,
      closed_opt_in_count: 1,
      wallet_balance_npr: 700,
    };
    expect(vendorDeactivateResponseSchema.safeParse(body).success).toBe(true);
    expect(vendorDeactivateResponseSchema.safeParse({ ...body, status: 'LIVE' }).success).toBe(
      false,
    );
    // A shop in debt is never closed, so the balance in the answer is never negative.
    expect(
      vendorDeactivateResponseSchema.safeParse({ ...body, wallet_balance_npr: -1 }).success,
    ).toBe(false);
  });

  it('names the four things that stand in the way', () => {
    expect(vendorDeactivationBlockers).toEqual([
      'NEGATIVE_BALANCE',
      'ACTIVE_ORDERS',
      'PENDING_PAYOUT',
      'AD_FEES_DUE',
    ]);
  });
});

describe('vendor.compliance_restored', () => {
  it('is a domain event on notifications.broadcast', () => {
    expect(domainEventSchema.safeParse(restored).success).toBe(true);
    expect(DOMAIN_EVENT_TOPICS['vendor.compliance_restored']).toBe('notifications.broadcast');
  });

  it('says where the lift left the shop: any standing but the two it cannot be', () => {
    const withStatus = (status: string) => ({
      ...restored,
      payload: { ...restored.payload, status },
    });
    for (const status of ['LIVE', 'APPROVED', 'SANDBOXED', 'SUSPENDED']) {
      expect(domainEventSchema.safeParse(withStatus(status)).success).toBe(true);
    }
    for (const status of ['SUSPENDED_COMPLIANCE', 'DEACTIVATED']) {
      expect(domainEventSchema.safeParse(withStatus(status)).success).toBe(false);
    }
  });
});

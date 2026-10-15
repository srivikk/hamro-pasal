import { DOMAIN_EVENT_TOPICS, domainEventSchema } from '../events/domain-events';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const AT = '2026-10-09T06:15:00.000Z';

const envelope = (type: string, payload: Record<string, unknown>) => ({
  event_id: '44444444-4444-4444-8444-444444444444',
  event_type: type,
  event_version: 1,
  occurred_at: AT,
  aggregate_id: VENDOR_ID,
  payload,
});

const deactivated = {
  vendor_id: VENDOR_ID,
  vendor_phone: '+9779800000011',
  wallet_balance_npr: 700,
  cancelled_ad_count: 2,
  returned_npr: 200,
  deactivated_at: AT,
};

const reactivated = {
  vendor_id: VENDOR_ID,
  vendor_phone: '+9779800000011',
  status: 'LIVE',
  reactivated_by_user_id: ADMIN_ID,
  reactivated_at: AT,
};

describe('vendor.deactivated', () => {
  it('is a domain event on notifications.broadcast', () => {
    expect(domainEventSchema.safeParse(envelope('vendor.deactivated', deactivated)).success).toBe(
      true,
    );
    expect(DOMAIN_EVENT_TOPICS['vendor.deactivated']).toBe('notifications.broadcast');
  });

  it('never carries a debt (a shop in debt is not closed) or an unknown key', () => {
    for (const payload of [
      { ...deactivated, wallet_balance_npr: -1 },
      { ...deactivated, cancelled_ad_count: 1.5 },
      { ...deactivated, vendor_phone: '9800000011' },
      { ...deactivated, device_tokens: ['ExponentPushToken[x]'] },
    ]) {
      expect(domainEventSchema.safeParse(envelope('vendor.deactivated', payload)).success).toBe(
        false,
      );
    }
  });
});

describe('vendor.reactivated', () => {
  it('is a domain event on notifications.broadcast', () => {
    expect(domainEventSchema.safeParse(envelope('vendor.reactivated', reactivated)).success).toBe(
      true,
    );
    expect(DOMAIN_EVENT_TOPICS['vendor.reactivated']).toBe('notifications.broadcast');
  });

  it('leaves the shop LIVE or waiting for its PAN, and nowhere else', () => {
    const withStatus = (status: string) =>
      envelope('vendor.reactivated', { ...reactivated, status });
    for (const status of ['LIVE', 'SUSPENDED_COMPLIANCE']) {
      expect(domainEventSchema.safeParse(withStatus(status)).success).toBe(true);
    }
    for (const status of ['DEACTIVATED', 'SUSPENDED', 'APPROVED', 'SANDBOXED']) {
      expect(domainEventSchema.safeParse(withStatus(status)).success).toBe(false);
    }
  });
});

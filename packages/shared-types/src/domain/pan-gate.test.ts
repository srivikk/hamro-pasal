import { vendorStatuses } from './enums';
import { isPanVerified, panGatedStanding } from './pan-gate';

describe('the PAN gate (SPEC core 10, amended 2026-10-20)', () => {
  it('lets a shop with a verified PAN go LIVE', () => {
    expect(panGatedStanding('LIVE', true)).toEqual({ status: 'LIVE' });
  });

  it('holds a shop without a verified PAN in SUSPENDED_COMPLIANCE, remembering LIVE', () => {
    expect(panGatedStanding('LIVE', false)).toEqual({
      status: 'SUSPENDED_COMPLIANCE',
      status_before_compliance_suspension: 'LIVE',
    });
  });

  it('never touches any other target', () => {
    for (const target of vendorStatuses.filter((status) => status !== 'LIVE')) {
      expect(panGatedStanding(target, false)).toEqual({ status: target });
      expect(panGatedStanding(target, true)).toEqual({ status: target });
    }
  });

  it('reads verification from pan_verified_at alone', () => {
    expect(isPanVerified({ pan_verified_at: null })).toBe(false);
    expect(isPanVerified({ pan_verified_at: new Date() })).toBe(true);
    expect(isPanVerified({ pan_verified_at: '2026-10-20T00:00:00.000Z' })).toBe(true);
  });
});

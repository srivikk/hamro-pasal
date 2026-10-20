import { complianceReminder } from './compliance-reminder';

const NONE = { tax_id: null, has_pan_document: false, pan_verified_at: null };

describe('the compliance banner (SPEC core 10, amended 2026-10-20)', () => {
  it('shows nothing until the server has answered', () => {
    expect(complianceReminder(undefined)).toBeNull();
  });

  it('asks for the PAN, then the certificate', () => {
    expect(complianceReminder(NONE)).toBe('panBanner');
    expect(complianceReminder({ ...NONE, tax_id: '301456789' })).toBe('documentBanner');
  });

  it('says the shop is offline pending verification once both are in', () => {
    expect(complianceReminder({ ...NONE, tax_id: '301456789', has_pan_document: true })).toBe(
      'verificationBanner',
    );
  });

  it('says nothing to a verified shop', () => {
    expect(
      complianceReminder({
        tax_id: '301456789',
        has_pan_document: true,
        pan_verified_at: '2026-10-20T06:00:00.000Z',
      }),
    ).toBeNull();
  });
});

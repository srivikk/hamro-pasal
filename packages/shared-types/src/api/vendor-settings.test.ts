import { vendorBankAccountSchema } from '../domain/entities';
import { vendorStatuses } from '../domain/enums';
import { deliverySettingsRequestSchema, taxIdentityRequestSchema } from './vendor-settings';

const radius = {
  fulfillment_mode: 'SELF_DELIVERY',
  delivery_scope: 'RADIUS_BOUND',
  radius_km: 5,
  serviceable_palikas: [],
  base_delivery_fee_npr: 50,
  delivery_fee_per_km_npr: 10,
  free_delivery_above_npr: 1500,
} as const;

const settings = (body: unknown) => deliverySettingsRequestSchema.safeParse(body).success;
const taxIdentity = (body: unknown) => taxIdentityRequestSchema.safeParse(body).success;

describe('vendor status', () => {
  it('has the compliance suspension beside the debt / admin one', () => {
    expect(vendorStatuses).toEqual([
      'SANDBOXED',
      'APPROVED',
      'LIVE',
      'SUSPENDED',
      'SUSPENDED_COMPLIANCE',
    ]);
  });
});

describe('tax identity request', () => {
  it('takes a PAN of exactly nine digits', () => {
    expect(taxIdentity({ tax_id: '302118845', is_vat_registered: false })).toBe(true);
    for (const taxId of ['30211884', '3021188450', '30211884A', ' 302118845', '३०२११८८४५', '']) {
      expect(taxIdentity({ tax_id: taxId, is_vat_registered: false })).toBe(false);
    }
  });

  it('trims the optional name and address, clears them with null, and refuses a blank', () => {
    expect(
      taxIdentityRequestSchema.parse({
        tax_id: '302118845',
        is_vat_registered: true,
        legal_name: '  Thamel Kirana Pasal Pvt. Ltd. ',
        registered_address: null,
      }),
    ).toEqual({
      tax_id: '302118845',
      is_vat_registered: true,
      legal_name: 'Thamel Kirana Pasal Pvt. Ltd.',
      registered_address: null,
    });
    expect(taxIdentity({ tax_id: '302118845', is_vat_registered: true, legal_name: '   ' })).toBe(
      false,
    );
  });

  it('cannot set a status, a verification or another shop', () => {
    const body = { tax_id: '302118845', is_vat_registered: false };
    for (const extra of [
      { status: 'LIVE' },
      { pan_verified_at: '2026-10-07T00:00:00.000Z' },
      { vendor_id: '11111111-1111-4111-8111-111111111111' },
    ]) {
      expect(taxIdentity({ ...body, ...extra })).toBe(false);
    }
    expect(taxIdentity({ tax_id: '302118845' })).toBe(false);
  });
});

describe('delivery settings request', () => {
  it('accepts each scope tier with its own fields', () => {
    expect(settings(radius)).toBe(true);
    expect(
      settings({
        ...radius,
        delivery_scope: 'CITY_WIDE',
        radius_km: null,
        serviceable_palikas: ['Lalitpur Metropolitan City', 'Kirtipur Municipality'],
      }),
    ).toBe(true);
    expect(settings({ ...radius, delivery_scope: 'NATION_WIDE', radius_km: null })).toBe(true);
  });

  it('wants a radius exactly for the radius tier, above 0 and at most 100 km', () => {
    expect(settings({ ...radius, radius_km: null })).toBe(false);
    expect(settings({ ...radius, radius_km: 0 })).toBe(false);
    expect(settings({ ...radius, radius_km: 100 })).toBe(true);
    expect(settings({ ...radius, radius_km: 100.01 })).toBe(false);
    expect(settings({ ...radius, delivery_scope: 'NATION_WIDE' })).toBe(false);
  });

  it('lists municipalities only for the city tier, each once, at most 30', () => {
    expect(settings({ ...radius, serviceable_palikas: ['Kathmandu Metropolitan City'] })).toBe(
      false,
    );
    const city = { ...radius, delivery_scope: 'CITY_WIDE', radius_km: null };
    expect(settings({ ...city, serviceable_palikas: [] })).toBe(true);
    expect(
      settings({
        ...city,
        serviceable_palikas: ['Bhaktapur Municipality', 'bhaktapur municipality'],
      }),
    ).toBe(false);
    expect(settings({ ...city, serviceable_palikas: ['  '] })).toBe(false);
    // Only a known Palika, in any letter case.
    expect(settings({ ...city, serviceable_palikas: ['pokhara metropolitan city'] })).toBe(true);
    expect(settings({ ...city, serviceable_palikas: ['Gotham City'] })).toBe(false);
  });

  it('lets a self-delivery shop charge 0 and refuses any charge under platform delivery', () => {
    expect(
      settings({
        ...radius,
        base_delivery_fee_npr: 0,
        delivery_fee_per_km_npr: 0,
        free_delivery_above_npr: null,
      }),
    ).toBe(true);
    const fleet = {
      ...radius,
      fulfillment_mode: 'PLATFORM_FLEET',
      base_delivery_fee_npr: 0,
      delivery_fee_per_km_npr: 0,
      free_delivery_above_npr: null,
    };
    expect(settings(fleet)).toBe(true);
    expect(settings({ ...fleet, base_delivery_fee_npr: 50 })).toBe(false);
    expect(settings({ ...fleet, delivery_fee_per_km_npr: 5 })).toBe(false);
    expect(settings({ ...fleet, free_delivery_above_npr: 1000 })).toBe(false);
  });

  it('has no "no delivery" mode, takes whole paisa and refuses unknown keys', () => {
    expect(settings({ ...radius, fulfillment_mode: 'NONE' })).toBe(false);
    expect(settings({ ...radius, fulfillment_mode: 'EMERGENCY_FLEET' })).toBe(false);
    expect(settings({ ...radius, base_delivery_fee_npr: 10.005 })).toBe(false);
    expect(settings({ ...radius, base_delivery_fee_npr: -1 })).toBe(false);
    expect(settings({ ...radius, free_delivery_above_npr: 0 })).toBe(false);
    expect(settings({ ...radius, accepting_orders: false })).toBe(false);
    expect(settings({ ...radius, municipality_palika_string: 'Pokhara' })).toBe(false);
  });
});

describe('vendor bank account', () => {
  const account = {
    id: '11111111-1111-4111-8111-111111111111',
    vendor_id: '22222222-2222-4222-8222-222222222222',
    bank_name: 'Nabil Bank',
    branch_name: 'Thamel',
    account_name: 'Thamel Kirana Pasal',
    account_number: '0123456789012',
    routing_or_swift_code: null,
    is_primary: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('takes an alphanumeric account number of 4 to 34 characters and an optional code', () => {
    expect(vendorBankAccountSchema.safeParse(account).success).toBe(true);
    expect(
      vendorBankAccountSchema.safeParse({ ...account, routing_or_swift_code: 'NARBNPKA' }).success,
    ).toBe(true);
    for (const accountNumber of ['123', '0123 4567', '01-23', 'x'.repeat(35)]) {
      expect(
        vendorBankAccountSchema.safeParse({ ...account, account_number: accountNumber }).success,
      ).toBe(false);
    }
    expect(vendorBankAccountSchema.safeParse({ ...account, bank_name: ' ' }).success).toBe(false);
  });
});

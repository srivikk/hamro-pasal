import { NEPAL_PROVINCES } from '@hamro-pasal/shared-types';

import {
  districtsForProvince,
  EMPTY_ADDRESS_FORM,
  parseWard,
  validateAddressForm,
  type AddressFormValues,
} from './address-form';

const VALID: AddressFormValues = {
  label: 'HOME',
  recipientName: '',
  recipientPhone: '',
  provinceId: 3,
  district: 'Kathmandu',
  palika: 'Kathmandu Metropolitan City',
  ward: '26',
  tole: 'Thamel',
  landmark: 'Near Kathmandu Guest House',
  pin: { latitude: 27.7154, longitude: 85.3123 },
};

const errorsOf = (values: AddressFormValues) => {
  const result = validateAddressForm(values);
  return result.ok ? {} : result.errors;
};

describe('validateAddressForm (shared-types nepalAddressInputSchema)', () => {
  it('accepts a complete Nepal address and returns the schema output', () => {
    expect(validateAddressForm(VALID)).toEqual({
      ok: true,
      label: 'HOME',
      recipient: null,
      address: {
        province_id: 3,
        district_string: 'Kathmandu',
        municipality_palika_string: 'Kathmandu Metropolitan City',
        ward_number: 26,
        tole_locality: 'Thamel',
        landmark: 'Near Kathmandu Guest House',
        exact_lat: 27.7154,
        exact_lng: 85.3123,
      },
    });
  });

  it.each(['34', '99', '0', '-1'])('rejects ward %p (1-33 only)', (ward) => {
    expect(Object.keys(errorsOf({ ...VALID, ward }))).toEqual(['ward_number']);
  });

  it.each(['1', '33'])('accepts the boundary ward %p', (ward) => {
    expect(validateAddressForm({ ...VALID, ward }).ok).toBe(true);
  });

  it.each(['', '2.5', '26a', 'twenty', ' '])('rejects the non-integer ward %p', (ward) => {
    expect(errorsOf({ ...VALID, ward }).ward_number).toBeDefined();
  });

  it('rejects a district from another province', () => {
    // Kathmandu is in Bagmati (3), not Koshi (1).
    const errors = errorsOf({ ...VALID, provinceId: 1 });

    expect(Object.keys(errors)).toEqual(['district_string']);
    expect(errors.district_string).toBe('Kathmandu is in Bagmati Province (3), not province 1');
  });

  it('rejects a district that does not exist', () => {
    expect(errorsOf({ ...VALID, district: 'Atlantis' }).district_string).toBe(
      'Unknown district "Atlantis"',
    );
  });

  it('canonicalises a district alias to its official spelling', () => {
    const result = validateAddressForm({
      ...VALID,
      district: 'Kavre',
      palika: 'Banepa Municipality',
    });

    expect(result.ok && result.address.district_string).toBe('Kavrepalanchok');
  });

  it('rejects a missing province', () => {
    expect(errorsOf({ ...VALID, provinceId: null }).province_id).toBeDefined();
  });

  it.each([0, 8])('rejects province %p (1-7 only)', (provinceId) => {
    expect(errorsOf({ ...VALID, provinceId }).province_id).toBeDefined();
  });

  it('requires palika, tole and landmark, and rejects whitespace-only text', () => {
    const errors = errorsOf({ ...VALID, palika: '', tole: '   ', landmark: '' });

    expect(Object.keys(errors).sort()).toEqual([
      'landmark',
      'municipality_palika_string',
      'tole_locality',
    ]);
  });

  it('requires a pin, and one inside Nepal', () => {
    expect(errorsOf({ ...VALID, pin: null }).pin).toBeDefined();
    expect(errorsOf({ ...VALID, pin: { latitude: 28.6139, longitude: 77.209 } }).pin).toBe(
      'Pin is outside Nepal',
    );
  });

  it('reports every field of an empty form', () => {
    expect(Object.keys(errorsOf(EMPTY_ADDRESS_FORM)).sort()).toEqual([
      'district_string',
      'landmark',
      'municipality_palika_string',
      'pin',
      'province_id',
      'tole_locality',
      'ward_number',
    ]);
  });
});

describe('parseWard', () => {
  it('accepts ASCII and Devanagari digits', () => {
    expect(parseWard('26')).toBe(26);
    expect(parseWard('२६')).toBe(26);
    expect(parseWard(' ३३ ')).toBe(33);
  });

  it('turns anything else into NaN', () => {
    expect(parseWard('2.5')).toBeNaN();
    expect(parseWard('')).toBeNaN();
    expect(parseWard('२६a')).toBeNaN();
  });
});

describe('districtsForProvince (cascade)', () => {
  it('offers nothing before a province is chosen', () => {
    expect(districtsForProvince(null)).toEqual([]);
  });

  it('offers only that province, covering all 77 districts across the 7 provinces', () => {
    expect(districtsForProvince(3)).toContain('Kathmandu');
    expect(districtsForProvince(1)).not.toContain('Kathmandu');
    const all = NEPAL_PROVINCES.flatMap((province) => districtsForProvince(province.id));
    expect(all).toHaveLength(77);
    expect(new Set(all).size).toBe(77);
  });

  it('offers nothing for an unknown province id', () => {
    expect(districtsForProvince(9)).toEqual([]);
  });
});

describe('validateAddressForm: the address label and the OTHER recipient', () => {
  it('keeps the label, and never a recipient, for HOME and WORK', () => {
    const work = validateAddressForm({
      ...VALID,
      label: 'WORK',
      recipientName: 'Ignored',
      recipientPhone: '9800000002',
    });

    expect(work).toMatchObject({ ok: true, label: 'WORK', recipient: null });
  });

  it('requires a name and a Nepal mobile number for OTHER', () => {
    expect(Object.keys(errorsOf({ ...VALID, label: 'OTHER' })).sort()).toEqual([
      'recipient_name',
      'recipient_phone',
    ]);
    expect(
      Object.keys(
        errorsOf({ ...VALID, label: 'OTHER', recipientName: 'Sita', recipientPhone: '12345' }),
      ),
    ).toEqual(['recipient_phone']);
    expect(
      Object.keys(
        errorsOf({ ...VALID, label: 'OTHER', recipientName: '   ', recipientPhone: '9800000002' }),
      ),
    ).toEqual(['recipient_name']);
  });

  it('returns the recipient with a trimmed name and a strict +977 number (Nepali digits too)', () => {
    const result = validateAddressForm({
      ...VALID,
      label: 'OTHER',
      recipientName: '  Sita Gurung ',
      recipientPhone: '९८०००००००२',
    });

    expect(result).toMatchObject({
      ok: true,
      label: 'OTHER',
      recipient: { name: 'Sita Gurung', phone: '+9779800000002' },
    });
  });

  it('reports recipient and address problems together', () => {
    expect(Object.keys(errorsOf({ ...VALID, label: 'OTHER', ward: '99' })).sort()).toEqual([
      'recipient_name',
      'recipient_phone',
      'ward_number',
    ]);
  });
});

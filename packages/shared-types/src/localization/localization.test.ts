import { NEPAL_PHONE_REGEX } from '../domain/constants';
import { nepalAddressInputSchema, type NepalAddressInput } from './address';
import {
  lookupNepalDistrict,
  NEPAL_DISTRICTS_BY_PROVINCE,
  NEPAL_PROVINCES,
} from './nepal-geography';
import { toAsciiDigits, toNepaliNumerals } from './numerals';
import { InvalidNepalPhoneError, isNepalPhone, normalizeNepalPhone } from './phone';

describe('toNepaliNumerals', () => {
  it.each([
    [0, '०'],
    [1234567890, '१२३४५६७८९०'],
    [1250.5, '१२५०.५'],
    [-42, '-४२'],
    [0.07, '०.०७'],
    [-0, '०'],
  ])('renders %p as %p', (input, expected) => {
    expect(toNepaliNumerals(input)).toBe(expected);
  });

  it('maps every ASCII digit to its Devanagari counterpart', () => {
    expect(toNepaliNumerals(9876543210)).toBe('९८७६५४३२१०');
  });

  it('never uses exponent notation or digit grouping', () => {
    expect(toNepaliNumerals(1e21)).toBe('१०००००००००००००००००००००');
    expect(toNepaliNumerals(1_000_000)).toBe('१००००००');
  });

  it('rejects NaN and infinities', () => {
    expect(() => toNepaliNumerals(Number.NaN)).toThrow(RangeError);
    expect(() => toNepaliNumerals(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('+977 phone validation', () => {
  it.each(['+9779812345678', '+9779612345678', '+9779712345678'])('accepts %s', (phone) => {
    expect(NEPAL_PHONE_REGEX.test(phone)).toBe(true);
    expect(isNepalPhone(phone)).toBe(true);
  });

  it.each([
    ['9812345678', 'national form without country code'],
    ['+977981234567', '9 digits'],
    ['+97798123456789', '11 digits'],
    ['+9778812345678', 'does not start with 9 (landline-style)'],
    ['+9199812345678', 'another country code'],
    ['+977 9812345678', 'contains a space'],
    [' +9779812345678', 'leading whitespace'],
  ])('rejects %s (%s)', (phone) => {
    expect(NEPAL_PHONE_REGEX.test(phone)).toBe(false);
  });

  it.each([
    ['9812345678', '+9779812345678'],
    ['+977-981-234-5678', '+9779812345678'],
    ['977 9812345678', '+9779812345678'],
    ['00977 (981) 234 5678', '+9779812345678'],
    ['  +9779812345678 ', '+9779812345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeNepalPhone(input)).toBe(expected);
  });

  it.each(['+919812345678', '8812345678', '981234567', '98123456789', 'abc', ''])(
    'refuses to normalise %p',
    (input) => {
      expect(() => normalizeNepalPhone(input)).toThrow(InvalidNepalPhoneError);
    },
  );
});

describe('Nepal geography', () => {
  it('has 7 provinces and 77 districts, each in exactly one province', () => {
    const all = NEPAL_PROVINCES.flatMap((p) => NEPAL_DISTRICTS_BY_PROVINCE[p.id]);

    expect(NEPAL_PROVINCES).toHaveLength(7);
    expect(all).toHaveLength(77);
    expect(new Set(all).size).toBe(77);
    expect(NEPAL_PROVINCES.map((p) => NEPAL_DISTRICTS_BY_PROVINCE[p.id].length)).toEqual([
      14, 8, 13, 11, 12, 10, 9,
    ]);
  });

  it('resolves case, spacing and common alternative spellings', () => {
    expect(lookupNepalDistrict('  kathmandu ')).toEqual({ district: 'Kathmandu', provinceId: 3 });
    expect(lookupNepalDistrict('Kavre')).toEqual({ district: 'Kavrepalanchok', provinceId: 3 });
    expect(lookupNepalDistrict('Nawalparasi West')).toEqual({ district: 'Parasi', provinceId: 5 });
    expect(lookupNepalDistrict('Atlantis')).toBeUndefined();
  });
});

describe('nepalAddressInputSchema', () => {
  const thamel: NepalAddressInput = {
    province_id: 3,
    district_string: 'Kathmandu',
    municipality_palika_string: 'Kathmandu Metropolitan City',
    ward_number: 26,
    tole_locality: 'Thamel',
    landmark: 'Near Kathmandu Guest House',
    exact_lat: 27.7149,
    exact_lng: 85.3106,
  };

  const issues = (input: unknown) => {
    const result = nepalAddressInputSchema.safeParse(input);
    return result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('accepts a complete Nepali address and canonicalises the district', () => {
    expect(nepalAddressInputSchema.parse({ ...thamel, district_string: 'KATHMANDU' })).toEqual(
      thamel,
    );
  });

  it.each([0, 8, 3.5])('rejects province_id %p', (province_id) => {
    expect(issues({ ...thamel, province_id })[0]).toMatch(/^province_id/);
  });

  it('rejects a district that belongs to another province', () => {
    expect(issues({ ...thamel, district_string: 'Kaski' })).toEqual([
      'district_string: Kaski is in Gandaki Province (4), not province 3',
    ]);
  });

  it('rejects unknown districts', () => {
    expect(issues({ ...thamel, district_string: 'Springfield' })).toEqual([
      'district_string: Unknown district "Springfield"',
    ]);
  });

  it.each([0, 34, 2.5])('rejects ward_number %p', (ward_number) => {
    expect(issues({ ...thamel, ward_number })[0]).toMatch(/^ward_number/);
  });

  it.each(['municipality_palika_string', 'tole_locality', 'landmark'])(
    'requires a non-blank %s',
    (field) => {
      expect(issues({ ...thamel, [field]: '   ' })).toEqual([`${field}: ${field} is required`]);
    },
  );

  it('rejects Western postcode fields and pins outside Nepal', () => {
    expect(issues({ ...thamel, zip_code: '44600' })[0]).toMatch(/Unrecognized key/);
    expect(issues({ ...thamel, exact_lat: 51.5, exact_lng: -0.12 })).toEqual([
      'exact_lat: Pin is outside Nepal',
      'exact_lng: Pin is outside Nepal',
    ]);
  });
});

describe('toAsciiDigits', () => {
  it('turns Devanagari digits into ASCII and leaves everything else alone', () => {
    expect(toAsciiDigits('९८०००००००१')).toBe('9800000001');
    expect(toAsciiDigits('०४२१८७')).toBe('042187');
    expect(toAsciiDigits('98-००')).toBe('98-00');
    expect(toAsciiDigits('abc')).toBe('abc');
  });

  it('round-trips with toNepaliNumerals', () => {
    expect(toAsciiDigits(toNepaliNumerals(9876543210))).toBe('9876543210');
  });
});

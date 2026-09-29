import {
  NEPAL_DISTRICTS_BY_PROVINCE,
  nepalAddressInputSchema,
  type NepalAddress,
  type NepalProvinceId,
} from '@hamro-pasal/shared-types';

/** What the form edits: free text as typed, choices as picked. Converted only on submit. */
export interface AddressFormValues {
  provinceId: number | null;
  district: string | null;
  palika: string;
  /** As typed; ASCII or Devanagari digits. */
  ward: string;
  tole: string;
  landmark: string;
  pin: { latitude: number; longitude: number } | null;
}

export type AddressField =
  | 'province_id'
  | 'district_string'
  | 'municipality_palika_string'
  | 'ward_number'
  | 'tole_locality'
  | 'landmark'
  | 'pin';

export type AddressValidation =
  | { ok: true; address: NepalAddress }
  | { ok: false; errors: Partial<Record<AddressField, string>> };

export const EMPTY_ADDRESS_FORM: AddressFormValues = {
  provinceId: null,
  district: null,
  palika: '',
  ward: '',
  tole: '',
  landmark: '',
  pin: null,
};

export function addressToFormValues(address: NepalAddress): AddressFormValues {
  return {
    provinceId: address.province_id,
    district: address.district_string,
    palika: address.municipality_palika_string,
    ward: String(address.ward_number),
    tole: address.tole_locality,
    landmark: address.landmark,
    pin: { latitude: address.exact_lat, longitude: address.exact_lng },
  };
}

/** Districts to offer once a province is picked (the cascade). Empty until then. */
export function districtsForProvince(provinceId: number | null): readonly string[] {
  if (provinceId === null) return [];
  // Unknown ids (never offered by the picker) are caught by the schema on submit.
  return provinceId in NEPAL_DISTRICTS_BY_PROVINCE
    ? NEPAL_DISTRICTS_BY_PROVINCE[provinceId as NepalProvinceId]
    : [];
}

const DEVANAGARI_ZERO = '०'.charCodeAt(0);

/**
 * A ward typed on a Nepali keyboard arrives as Devanagari digits ("२६"). Both scripts are
 * accepted; anything that is not purely digits becomes NaN, which the schema rejects.
 */
export function parseWard(input: string): number {
  const ascii = input
    .trim()
    .replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - DEVANAGARI_ZERO));
  return /^[0-9]+$/.test(ascii) ? Number(ascii) : Number.NaN;
}

function fieldOf(path: readonly PropertyKey[]): AddressField | null {
  const [first] = path;
  switch (first) {
    case 'province_id':
    case 'district_string':
    case 'municipality_palika_string':
    case 'ward_number':
    case 'tole_locality':
    case 'landmark':
      return first;
    case 'exact_lat':
    case 'exact_lng':
      return 'pin';
    default:
      return null;
  }
}

/**
 * Validates with the shared-types schema itself (the same rules the API applies): province 1-7,
 * a district that exists and belongs to that province, ward 1-33, non-blank text, and a pin
 * inside Nepal. Returns the canonical address, or the schema's message for each failing field.
 */
export function validateAddressForm(values: AddressFormValues): AddressValidation {
  const result = nepalAddressInputSchema.safeParse({
    province_id: values.provinceId ?? undefined,
    district_string: values.district ?? '',
    municipality_palika_string: values.palika,
    ward_number: parseWard(values.ward),
    tole_locality: values.tole,
    landmark: values.landmark,
    exact_lat: values.pin?.latitude,
    exact_lng: values.pin?.longitude,
  });
  if (result.success) return { ok: true, address: result.data };

  const errors: Partial<Record<AddressField, string>> = {};
  for (const issue of result.error.issues) {
    const field = fieldOf(issue.path);
    if (field !== null) errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}

/** One-line summary, e.g. "Thamel, Kathmandu Metropolitan City-26, Kathmandu". */
export function formatAddressLine(address: NepalAddress, ward: string): string {
  return `${address.tole_locality}, ${address.municipality_palika_string}-${ward}, ${address.district_string}`;
}

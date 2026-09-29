import { z } from 'zod';

import { NEPAL_PROVINCE_ID_MAX, NEPAL_PROVINCE_ID_MIN } from '../domain/constants';
import { NEPAL_BOUNDING_BOX } from '../nepal/geo';
import { lookupNepalDistrict, NEPAL_MAX_WARD_NUMBER, NEPAL_PROVINCES } from './nepal-geography';

const text = (field: string) =>
  z
    .string({ error: `${field} is required` })
    .trim()
    .min(1, `${field} is required`)
    .max(120, `${field} is too long`);

/**
 * A customer delivery address in the Nepal hierarchy (SPEC: Nepal localizations §3):
 * Province (1-7) -> District -> Municipality/Palika -> Ward -> Tole, plus a landmark and the
 * "Drop a Pin" coordinates. The district must belong to the given province, and is normalised
 * to its canonical spelling (e.g. "kavre" -> "Kavrepalanchok").
 */
export const nepalAddressInputSchema = z
  .strictObject({
    province_id: z
      .number({ error: 'province_id must be a number' })
      .int('province_id must be an integer')
      .min(NEPAL_PROVINCE_ID_MIN, 'province_id must be between 1 and 7')
      .max(NEPAL_PROVINCE_ID_MAX, 'province_id must be between 1 and 7'),
    district_string: text('district_string'),
    municipality_palika_string: text('municipality_palika_string'),
    ward_number: z
      .number({ error: 'ward_number must be a number' })
      .int('ward_number must be an integer')
      .min(1, 'ward_number must be at least 1')
      .max(NEPAL_MAX_WARD_NUMBER, `ward_number cannot exceed ${String(NEPAL_MAX_WARD_NUMBER)}`),
    tole_locality: text('tole_locality'),
    landmark: text('landmark'),
    exact_lat: z
      .number()
      .min(NEPAL_BOUNDING_BOX.minLat, 'Pin is outside Nepal')
      .max(NEPAL_BOUNDING_BOX.maxLat, 'Pin is outside Nepal'),
    exact_lng: z
      .number()
      .min(NEPAL_BOUNDING_BOX.minLng, 'Pin is outside Nepal')
      .max(NEPAL_BOUNDING_BOX.maxLng, 'Pin is outside Nepal'),
  })
  .transform((address, ctx) => {
    const match = lookupNepalDistrict(address.district_string);
    if (match === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['district_string'],
        message: `Unknown district "${address.district_string}"`,
      });
      return z.NEVER;
    }
    if (match.provinceId !== address.province_id) {
      const province = NEPAL_PROVINCES.find((p) => p.id === match.provinceId);
      ctx.addIssue({
        code: 'custom',
        path: ['district_string'],
        message: `${match.district} is in ${province?.name ?? 'another'} Province (${String(match.provinceId)}), not province ${String(address.province_id)}`,
      });
      return z.NEVER;
    }
    return { ...address, district_string: match.district };
  });

export type NepalAddressInput = z.input<typeof nepalAddressInputSchema>;
export type NepalAddress = z.output<typeof nepalAddressInputSchema>;

import { z } from 'zod';

import { canonicalPalika } from '../constants/palikas';
import {
  deliveryScopeSchema,
  vendorFulfillmentModeSchema,
  vendorStatusSchema,
} from '../domain/enums';

/** A PAN is exactly nine digits (SPEC Nepal section 5). A VAT number is the PAN. */
export const PAN_PATTERN = '^[0-9]{9}$';
export const panSchema = z.string().regex(new RegExp(PAN_PATTERN), 'A PAN is nine digits');

export const MAX_LEGAL_NAME_LENGTH = 120;
export const MAX_REGISTERED_ADDRESS_LENGTH = 200;

/**
 * PUT /api/vendor/tax-identity (SPEC core section 10, "PAN is mandatory").
 *
 * Saving a PAN lifts a compliance suspension in the same transaction. Saving a different PAN
 * clears the Super Admin's verification, which freezes payouts until the new one is verified.
 * `legal_name` and `registered_address` are kept as they are when omitted, and cleared by null.
 */
export const taxIdentityRequestSchema = z.strictObject({
  tax_id: panSchema,
  is_vat_registered: z.boolean(),
  legal_name: z.string().trim().min(1).max(MAX_LEGAL_NAME_LENGTH).nullable().optional(),
  registered_address: z
    .string()
    .trim()
    .min(1)
    .max(MAX_REGISTERED_ADDRESS_LENGTH)
    .nullable()
    .optional(),
});
export type TaxIdentityRequest = z.infer<typeof taxIdentityRequestSchema>;

export const taxIdentityResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  tax_id: panSchema,
  is_vat_registered: z.boolean(),
  legal_name: z.string().nullable(),
  registered_address: z.string().nullable(),
  /** The shop's status after the save: never SUSPENDED_COMPLIANCE. */
  status: vendorStatusSchema,
  /** True when this save lifted a compliance suspension. */
  compliance_suspension_lifted: z.boolean(),
  /** Null until a Super Admin verifies this PAN; payouts wait for it. */
  pan_verified_at: z.iso.datetime().nullable(),
});
export type TaxIdentityResponseBody = z.infer<typeof taxIdentityResponseSchema>;

export const MAX_DELIVERY_RADIUS_KM = 100;
export const MAX_SERVICEABLE_PALIKAS = 30;
export const MAX_PALIKA_NAME_LENGTH = 80;
export const MAX_VENDOR_DELIVERY_FEE_NPR = 100_000;

const fee = z.number().min(0).multipleOf(0.01).max(MAX_VENDOR_DELIVERY_FEE_NPR);

/**
 * PUT /api/vendor/delivery-settings (SPEC Dual-Fulfillment, "Delivery Modularity"). It replaces
 * all seven settings; they apply to new orders at once (each order keeps what it was placed with).
 *
 * A vendor always has exactly one delivery mode: there is no "none". The mode must be one the
 * Super Admin has enabled (422 DELIVERY_MODE_DISABLED, decided by the server).
 */
export const deliverySettingsRequestSchema = z
  .strictObject({
    fulfillment_mode: vendorFulfillmentModeSchema,
    delivery_scope: deliveryScopeSchema,
    /** Required for RADIUS_BOUND. Null for the other scopes: the stored radius is kept. */
    radius_km: z.number().positive().max(MAX_DELIVERY_RADIUS_KM).multipleOf(0.01).nullable(),
    /**
     * The municipalities a CITY_WIDE shop serves, by Palika name. The shop's own Palika is always
     * served and is added if missing. Must be empty for the other scopes.
     */
    serviceable_palikas: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(MAX_PALIKA_NAME_LENGTH)
          // Stored in the list's own spelling, whatever letter case was sent.
          .transform((name) => canonicalPalika(name) ?? name),
      )
      .max(MAX_SERVICEABLE_PALIKAS),
    base_delivery_fee_npr: fee,
    /** Charged per kilometre, for the RADIUS_BOUND scope only. */
    delivery_fee_per_km_npr: fee,
    /** Delivery is free at or above this subtotal; null for no threshold. */
    free_delivery_above_npr: fee.positive().nullable(),
  })
  .refine((s) => (s.delivery_scope === 'RADIUS_BOUND') === (s.radius_km !== null), {
    path: ['radius_km'],
    message: 'A radius is given exactly for the RADIUS_BOUND scope',
  })
  .refine((s) => s.serviceable_palikas.every((name) => canonicalPalika(name) !== null), {
    path: ['serviceable_palikas'],
    message: 'Unknown municipality',
  })
  .refine((s) => s.delivery_scope === 'CITY_WIDE' || s.serviceable_palikas.length === 0, {
    path: ['serviceable_palikas'],
    message: 'Only a CITY_WIDE shop lists municipalities',
  })
  .refine(
    (s) =>
      new Set(s.serviceable_palikas.map((name) => name.toLowerCase())).size ===
      s.serviceable_palikas.length,
    { path: ['serviceable_palikas'], message: 'A municipality is listed once' },
  )
  .refine(
    (s) =>
      s.fulfillment_mode === 'SELF_DELIVERY' ||
      (s.base_delivery_fee_npr === 0 &&
        s.delivery_fee_per_km_npr === 0 &&
        s.free_delivery_above_npr === null),
    {
      path: ['base_delivery_fee_npr'],
      message: 'The platform sets the charge for PLATFORM_FLEET deliveries',
    },
  );
export type DeliverySettingsRequest = z.infer<typeof deliverySettingsRequestSchema>;

/** GET and PUT /api/vendor/delivery-settings: the shop's settings and what the platform allows. */
export const deliverySettingsResponseSchema = z.strictObject({
  vendor_id: z.uuid(),
  fulfillment_mode: vendorFulfillmentModeSchema,
  delivery_scope: deliveryScopeSchema,
  radius_km: z.number().positive(),
  /** Always contains `municipality_palika_string`. */
  serviceable_palikas: z.array(z.string().min(1)).min(1),
  municipality_palika_string: z.string().min(1),
  base_delivery_fee_npr: z.number().min(0),
  delivery_fee_per_km_npr: z.number().min(0),
  free_delivery_above_npr: z.number().positive().nullable(),
  /** The Super Admin's switches. With both off (the Emergency Stop) no shop takes orders. */
  platform: z.strictObject({
    self_delivery_enabled: z.boolean(),
    platform_fleet_enabled: z.boolean(),
    platform_delivery_fee_npr: z.number().min(0),
  }),
  /** False when the shop's own mode is switched off: it is forced Offline until that changes. */
  fulfillment_mode_enabled: z.boolean(),
});
export type DeliverySettingsResponseBody = z.infer<typeof deliverySettingsResponseSchema>;

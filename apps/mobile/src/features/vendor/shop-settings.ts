import { toAsciiDigits, type DeliverySettingsResponseBody } from '@hamro-pasal/shared-types';
import { z } from 'zod';

import type { DeliverySettingsDraft } from '../../api/vendor-delivery-settings';
import { isKnownPalika } from './mock-palikas';

/** A PAN is nine digits; a VAT-registered shop's VAT number is its PAN (SPEC Nepal section 5). */
export const TAX_ID_LENGTH = 9;
export const MAX_RADIUS_KM = 100;
export const MAX_SERVICEABLE_PALIKAS = 30;
export const MAX_PALIKA_NAME_LENGTH = 80;
export const MAX_FEE_NPR = 100_000;
/** Step 7.2: the highest minimum order value a shop may set (the API refuses more). */
export const MAX_MIN_ORDER_NPR = 50_000;

/** `PLATFORM_FLEET` is the platform's delivery; the app labels it "Platform delivery". */
export const FULFILLMENT_CHOICES = ['SELF_DELIVERY', 'PLATFORM_FLEET'] as const;
export type FulfillmentChoice = (typeof FULFILLMENT_CHOICES)[number];

/** The three scope tiers of SPEC Delivery Modularity, one at a time. */
export const SCOPE_CHOICES = ['RADIUS_BOUND', 'CITY_WIDE', 'NATION_WIDE'] as const;
export type ScopeChoice = (typeof SCOPE_CHOICES)[number];

const feeSchema = z.number().min(0).max(MAX_FEE_NPR);

/** The shop's configuration as the app keeps it (and will send it, once the API takes it). */
export const shopSettingsSchema = z.strictObject({
  taxId: z.string().regex(/^[0-9]{9}$/),
  fulfillmentMode: z.enum(FULFILLMENT_CHOICES),
  deliveryScope: z.enum(SCOPE_CHOICES),
  /** Set exactly when the scope is `RADIUS_BOUND`. */
  radiusKm: z.number().positive().max(MAX_RADIUS_KM).nullable(),
  /** Filled exactly when the scope is `CITY_WIDE`. */
  serviceablePalikas: z
    .array(z.string().min(1).max(MAX_PALIKA_NAME_LENGTH))
    .max(MAX_SERVICEABLE_PALIKAS),
  /** The three charges are the vendor's only under `SELF_DELIVERY`; otherwise 0 / 0 / null. */
  baseDeliveryFeeNpr: feeSchema,
  perKmFeeNpr: feeSchema,
  freeDeliveryAboveNpr: z.number().positive().max(MAX_FEE_NPR).nullable(),
  /** Step 7.2: under either mode. Settings saved before the field read as 0. */
  minOrderValueNpr: z.number().min(0).max(MAX_MIN_ORDER_NPR).default(0),
});
export type ShopSettings = z.infer<typeof shopSettingsSchema>;
/** What the store accepts: fields with a default may be left out. */
export type ShopSettingsInput = z.input<typeof shopSettingsSchema>;

/** The form's fields as typed. */
export interface ShopSettingsForm {
  taxId: string;
  fulfillmentMode: FulfillmentChoice;
  deliveryScope: ScopeChoice;
  radiusKm: string;
  palikas: readonly string[];
  baseFee: string;
  perKmFee: string;
  freeAbove: string;
  minOrder: string;
}

export type ShopSettingsField =
  'taxId' | 'radiusKm' | 'palikas' | 'baseFee' | 'perKmFee' | 'freeAbove' | 'minOrder';
export type ShopSettingsError = 'taxId' | 'radius' | 'palikas' | 'amount' | 'freeBelowMinimum';
export type ShopSettingsErrors = Partial<Record<ShopSettingsField, ShopSettingsError>>;

export type ShopSettingsResult =
  { ok: true; settings: ShopSettings } | { ok: false; errors: ShopSettingsErrors };

/** The delivery half of the settings: everything but the PAN, which has its own save. */
export type DeliverySettings = Omit<ShopSettings, 'taxId'>;
export type DeliverySettingsResult =
  { ok: true; settings: DeliverySettings } | { ok: false; errors: ShopSettingsErrors };

export const DEFAULT_SHOP_SETTINGS_FORM: ShopSettingsForm = {
  taxId: '',
  fulfillmentMode: 'SELF_DELIVERY',
  deliveryScope: 'RADIUS_BOUND',
  radiusKm: '5',
  palikas: [],
  baseFee: '0',
  perKmFee: '0',
  freeAbove: '',
  minOrder: '0',
};

/** The form for saved settings, or the defaults for a shop that has saved none. */
export function formFromSettings(settings: ShopSettings | null): ShopSettingsForm {
  if (settings === null) return DEFAULT_SHOP_SETTINGS_FORM;
  return {
    taxId: settings.taxId,
    fulfillmentMode: settings.fulfillmentMode,
    deliveryScope: settings.deliveryScope,
    radiusKm:
      settings.radiusKm === null ? DEFAULT_SHOP_SETTINGS_FORM.radiusKm : String(settings.radiusKm),
    palikas: settings.serviceablePalikas,
    baseFee: String(settings.baseDeliveryFeeNpr),
    perKmFee: String(settings.perKmFeeNpr),
    freeAbove: settings.freeDeliveryAboveNpr === null ? '' : String(settings.freeDeliveryAboveNpr),
    minOrder: String(settings.minOrderValueNpr),
  };
}

/** What the PAN field holds after a keystroke or a paste: ASCII digits only, at most nine. */
export function sanitizeTaxIdInput(input: string): string {
  return toAsciiDigits(input)
    .replace(/[^0-9]/g, '')
    .slice(0, TAX_ID_LENGTH);
}

/** What a number field holds: ASCII digits and one decimal point (Nepali digits converted). */
export function sanitizeAmountInput(input: string): string {
  const cleaned = toAsciiDigits(input).replace(/[^0-9.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  return rest.length === 0 ? whole : `${whole}.${rest.join('').slice(0, 2)}`;
}

/** A typed amount as a number; null when blank; NaN when it is not a plain amount. */
function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function normalisePalika(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/**
 * Adds a municipality to the list. Returns the list unchanged for a blank or over-long name, a
 * name already listed (any letter case) or a full list.
 */
export function addPalika(palikas: readonly string[], input: string): readonly string[] {
  const name = normalisePalika(input);
  if (name === '' || name.length > MAX_PALIKA_NAME_LENGTH) return palikas;
  if (palikas.length >= MAX_SERVICEABLE_PALIKAS) return palikas;
  if (palikas.some((existing) => existing.toLowerCase() === name.toLowerCase())) return palikas;
  return [...palikas, name];
}

/** The whole form, PAN included: what the phone's own copy of the settings needs. */
export function validateShopSettings(form: ShopSettingsForm): ShopSettingsResult {
  const delivery = validateDeliverySettings(form);
  const taxIdValid = /^[0-9]{9}$/.test(form.taxId);
  if (!delivery.ok || !taxIdValid) {
    return {
      ok: false,
      errors: {
        ...(delivery.ok ? {} : delivery.errors),
        ...(taxIdValid ? {} : { taxId: 'taxId' }),
      },
    };
  }
  return { ok: true, settings: { taxId: form.taxId, ...delivery.settings } };
}

/** The settings as PUT /api/vendor/delivery-settings takes them. */
export function deliveryRequestOf(settings: DeliverySettings): DeliverySettingsDraft {
  return {
    fulfillment_mode: settings.fulfillmentMode,
    delivery_scope: settings.deliveryScope,
    radius_km: settings.radiusKm,
    serviceable_palikas: [...settings.serviceablePalikas],
    base_delivery_fee_npr: settings.baseDeliveryFeeNpr,
    delivery_fee_per_km_npr: settings.perKmFeeNpr,
    free_delivery_above_npr: settings.freeDeliveryAboveNpr,
    min_order_value: settings.minOrderValueNpr,
  };
}

/**
 * The form for what the server holds. The municipality list is shown only for a City / Regional
 * shop (the server keeps the shop's own Palika in it for every scope); the stored radius is kept
 * for the day the shop returns to the Radius tier. The PAN is not part of this answer.
 */
export function formFromDeliveryResponse(
  server: DeliverySettingsResponseBody,
  taxId: string,
): ShopSettingsForm {
  return {
    taxId,
    fulfillmentMode: server.fulfillment_mode,
    deliveryScope: server.delivery_scope,
    radiusKm: String(server.radius_km),
    palikas: server.delivery_scope === 'CITY_WIDE' ? server.serviceable_palikas : [],
    baseFee: String(server.base_delivery_fee_npr),
    perKmFee: String(server.delivery_fee_per_km_npr),
    freeAbove:
      server.free_delivery_above_npr === null ? '' : String(server.free_delivery_above_npr),
    minOrder: String(server.min_order_value),
  };
}

/**
 * Checks the delivery half of the form and builds its settings. Fields that do not apply to the
 * chosen mode and scope are not checked and are saved empty: no radius outside `RADIUS_BOUND`,
 * no municipalities outside `CITY_WIDE`, and no charges under platform delivery (the platform
 * sets that fee).
 */
export function validateDeliverySettings(form: ShopSettingsForm): DeliverySettingsResult {
  const errors: ShopSettingsErrors = {};
  const selfDelivery = form.fulfillmentMode === 'SELF_DELIVERY';

  let radiusKm: number | null = null;
  if (form.deliveryScope === 'RADIUS_BOUND') {
    const radius = parseAmount(form.radiusKm);
    if (radius === null || Number.isNaN(radius) || radius <= 0 || radius > MAX_RADIUS_KM) {
      errors.radiusKm = 'radius';
    } else {
      radiusKm = radius;
    }
  }

  // Only names from the list count: a mistyped municipality would break delivery routing.
  const serviceablePalikas =
    form.deliveryScope === 'CITY_WIDE' ? form.palikas.filter(isKnownPalika) : [];
  if (form.deliveryScope === 'CITY_WIDE' && serviceablePalikas.length === 0) {
    errors.palikas = 'palikas';
  }

  let baseDeliveryFeeNpr = 0;
  let perKmFeeNpr = 0;
  let freeDeliveryAboveNpr: number | null = null;
  if (selfDelivery) {
    const fee = (field: 'baseFee' | 'perKmFee'): number => {
      const amount = parseAmount(form[field]) ?? 0; // blank means the default, 0
      if (Number.isNaN(amount) || amount > MAX_FEE_NPR) errors[field] = 'amount';
      return amount;
    };
    baseDeliveryFeeNpr = fee('baseFee');
    perKmFeeNpr = fee('perKmFee');
    const threshold = parseAmount(form.freeAbove);
    if (
      threshold !== null &&
      (Number.isNaN(threshold) || threshold <= 0 || threshold > MAX_FEE_NPR)
    ) {
      errors.freeAbove = 'amount';
    } else {
      freeDeliveryAboveNpr = threshold;
    }
  }

  // The minimum order applies under either mode; blank means none (0).
  const minOrderValueNpr = parseAmount(form.minOrder) ?? 0;
  if (Number.isNaN(minOrderValueNpr) || minOrderValueNpr > MAX_MIN_ORDER_NPR) {
    errors.minOrder = 'amount';
  } else if (
    errors.freeAbove === undefined &&
    freeDeliveryAboveNpr !== null &&
    freeDeliveryAboveNpr <= minOrderValueNpr
  ) {
    // Free delivery below the minimum order could never apply (the API refuses it too).
    errors.freeAbove = 'freeBelowMinimum';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      fulfillmentMode: form.fulfillmentMode,
      deliveryScope: form.deliveryScope,
      radiusKm,
      serviceablePalikas,
      baseDeliveryFeeNpr,
      perKmFeeNpr,
      freeDeliveryAboveNpr,
      minOrderValueNpr,
    },
  };
}

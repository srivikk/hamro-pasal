import { toAsciiDigits } from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { isKnownPalika } from './mock-palikas';

/** A PAN is nine digits; a VAT-registered shop's VAT number is its PAN (SPEC Nepal section 5). */
export const TAX_ID_LENGTH = 9;
export const MAX_RADIUS_KM = 100;
export const MAX_SERVICEABLE_PALIKAS = 30;
export const MAX_PALIKA_NAME_LENGTH = 80;
export const MAX_FEE_NPR = 100_000;

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
});
export type ShopSettings = z.infer<typeof shopSettingsSchema>;

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
}

export type ShopSettingsField =
  'taxId' | 'radiusKm' | 'palikas' | 'baseFee' | 'perKmFee' | 'freeAbove';
export type ShopSettingsError = 'taxId' | 'radius' | 'palikas' | 'amount';
export type ShopSettingsErrors = Partial<Record<ShopSettingsField, ShopSettingsError>>;

export type ShopSettingsResult =
  { ok: true; settings: ShopSettings } | { ok: false; errors: ShopSettingsErrors };

export const DEFAULT_SHOP_SETTINGS_FORM: ShopSettingsForm = {
  taxId: '',
  fulfillmentMode: 'SELF_DELIVERY',
  deliveryScope: 'RADIUS_BOUND',
  radiusKm: '5',
  palikas: [],
  baseFee: '0',
  perKmFee: '0',
  freeAbove: '',
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

/**
 * Checks the form and builds the settings. Fields that do not apply to the chosen mode and scope
 * are not checked and are saved empty: no radius outside `RADIUS_BOUND`, no municipalities outside
 * `CITY_WIDE`, and no charges under platform delivery (the platform sets that fee).
 */
export function validateShopSettings(form: ShopSettingsForm): ShopSettingsResult {
  const errors: ShopSettingsErrors = {};
  const selfDelivery = form.fulfillmentMode === 'SELF_DELIVERY';

  if (!/^[0-9]{9}$/.test(form.taxId)) errors.taxId = 'taxId';

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

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      taxId: form.taxId,
      fulfillmentMode: form.fulfillmentMode,
      deliveryScope: form.deliveryScope,
      radiusKm,
      serviceablePalikas,
      baseDeliveryFeeNpr,
      perKmFeeNpr,
      freeDeliveryAboveNpr,
    },
  };
}

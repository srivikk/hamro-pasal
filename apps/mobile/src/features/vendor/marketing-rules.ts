import { sanitizeAmountInput } from './shop-settings';

/** SPEC core sections 7 (Discounts) and 8 (Ad Monetization), as the Vendor App shows them. */

export const DISCOUNT_KINDS = ['FLAT', 'PERCENTAGE'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

export const MAX_OFFER_VALUE_NPR = 100_000;

/** A vendor's own offer (`vendor_offers`): funded by the vendor, never edited, only ended. */
export interface VendorOffer {
  id: string;
  kind: DiscountKind;
  /** NPR for FLAT, percent for PERCENTAGE. */
  value: number;
  minCartNpr: number;
  startsAt: string;
}

/** What the vendor fills in for a new offer. */
export type OfferDetails = Pick<VendorOffer, 'kind' | 'value' | 'minCartNpr'>;

export interface OfferForm {
  kind: DiscountKind;
  value: string;
  minCart: string;
}

export const EMPTY_OFFER_FORM: OfferForm = { kind: 'FLAT', value: '', minCart: '' };

export type OfferField = 'value' | 'minCart';
export type OfferFormError = 'flatValue' | 'percentValue' | 'minCart' | 'minBelowDiscount';
export type OfferFormErrors = Partial<Record<OfferField, OfferFormError>>;
export type OfferFormResult =
  { ok: true; details: OfferDetails } | { ok: false; errors: OfferFormErrors };

export { sanitizeAmountInput as sanitizeOfferInput };

const parseAmount = (text: string): number | null => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^[0-9]{1,7}(\.[0-9]{1,2})?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
};

/**
 * Checks a new offer by the rules of `vendor_offers`: a flat amount above 0, or a percentage above
 * 0 up to 100; a minimum order of 0 or more (blank means none); and a flat discount never larger
 * than its own minimum order, so an offer can never make the goods cost less than nothing.
 */
export function validateOfferForm(form: OfferForm): OfferFormResult {
  const errors: OfferFormErrors = {};
  const value = parseAmount(form.value);
  const valueOk =
    value !== null &&
    !Number.isNaN(value) &&
    value > 0 &&
    value <= (form.kind === 'FLAT' ? MAX_OFFER_VALUE_NPR : 100);
  if (!valueOk) errors.value = form.kind === 'FLAT' ? 'flatValue' : 'percentValue';

  const minCart = parseAmount(form.minCart) ?? 0;
  if (Number.isNaN(minCart) || minCart > MAX_OFFER_VALUE_NPR * 10) {
    errors.minCart = 'minCart';
  } else if (form.kind === 'FLAT' && valueOk && minCart < value) {
    errors.minCart = 'minBelowDiscount';
  }

  if (!valueOk || errors.minCart !== undefined) return { ok: false, errors };
  return { ok: true, details: { kind: form.kind, value, minCartNpr: minCart } };
}

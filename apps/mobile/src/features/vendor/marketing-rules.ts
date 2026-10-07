import { sanitizeAmountInput } from './shop-settings';
import { PREPAID_RESERVE_NPR, type SettlementModel } from './vendor-finance-mocks';

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

/** A platform campaign the shop is invited to (`platform_campaigns`), and its opt-in if any. */
export interface CampaignInvite {
  id: string;
  name: string;
  kind: DiscountKind;
  value: number;
  maxDiscountNpr: number | null;
  minCartNpr: number;
  /** The share of each discount this shop would bear; the platform funds the rest. */
  vendorSharePercent: number;
  termsVersion: number;
  startsAt: string;
  endsAt: string;
  /** Set once this shop's own account has opted in. */
  optedInAt: string | null;
}

export const AD_BILLING_MODELS = ['FLAT_RATE', 'PER_ORDER_PREMIUM'] as const;
export type AdBillingModel = (typeof AD_BILLING_MODELS)[number];

/** A placement on sale in the Ad Marketplace (`ad_products`). */
export interface AdProduct {
  id: string;
  /** `FEED_LISTING` is the sponsored listing in search and the feed ("Sponsored Search"). */
  slot: 'CAROUSEL' | 'FEED_LISTING';
  billingModel: AdBillingModel;
  /** For the whole period (FLAT_RATE), or per delivered order (PER_ORDER_PREMIUM). */
  priceNpr: number;
  durationDays: number;
  /** PER_ORDER_PREMIUM: the most the ad may cost in all. */
  budgetNpr: number | null;
}

export interface AdPurchase {
  id: string;
  adProductId: string;
  purchasedAt: string;
}

export interface AdFunds {
  model: SettlementModel;
  balanceNpr: number;
  pendingEscrowNpr: number;
  /** Flat-rate ads already bought: that money is spoken for. */
  committedNpr: number;
}

/** What a Model B shop can put towards a flat-rate ad: what the platform already holds for it. */
export function adFundsAvailable(funds: AdFunds): number {
  return funds.balanceNpr + funds.pendingEscrowNpr - funds.committedNpr;
}

/**
 * Whether the shop may buy the ad (SPEC Ad Monetization, "Collection by settlement model"):
 *  - Model B: a flat-rate ad needs `balance + pending escrow >= price`; a per-order ad is always
 *    allowed (its fee comes out of each order's settlement).
 *  - Model A: the price, or the whole budget, must be covered by the balance: never on credit.
 *  - Model C: the same, and the balance must stay at or above the Fixed Reserve.
 */
export function canBuyAd(funds: AdFunds, product: AdProduct): boolean {
  const cost = product.billingModel === 'FLAT_RATE' ? product.priceNpr : (product.budgetNpr ?? 0);
  switch (funds.model) {
    case 'PLATFORM_ESCROW':
      return product.billingModel === 'PER_ORDER_PREMIUM' || adFundsAvailable(funds) >= cost;
    case 'COD_CREDIT':
      return funds.balanceNpr - funds.committedNpr - cost >= 0;
    case 'DIRECT_PREPAID':
      return funds.balanceNpr - funds.committedNpr - cost >= PREPAID_RESERVE_NPR;
  }
}

import {
  adBillingModels,
  adBillingModelSchema,
  adProductCreateRequestSchema,
  adProductUpdateRequestSchema,
  adProductViewSchema,
  adSlots,
  adSlotSchema,
  type AdBillingModel,
  type AdProductCreate,
  type AdProductUpdate,
  type AdProductView,
  type AdSlot,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

/**
 * The contract of GET / POST / PATCH /api/admin/ads/products lives in
 * `@hamro-pasal/shared-types` (`api/admin-marketing.ts`) since the API serves it (Phase 26); the
 * form's rules below are built on it. Re-exported so the screen and its tests keep one import.
 *
 * The placements are the two the database has (`CAROUSEL`, `FEED_LISTING`). A published
 * product's placement, billing model, price and duration never change: the update schema has
 * only `name` and `is_active`.
 */
export {
  adBillingModels,
  adBillingModelSchema,
  adProductCreateRequestSchema,
  adProductUpdateRequestSchema,
  adProductViewSchema,
  adSlots,
  adSlotSchema,
};
export type { AdBillingModel, AdProductCreate, AdProductUpdate, AdProductView, AdSlot };

/** `FEED_LISTING` is what both apps call "Sponsored Search": the sponsored shop in the feed and in search. */
export const AD_SLOT_LABELS: Readonly<Record<AdSlot, string>> = {
  CAROUSEL: 'Home carousel',
  FEED_LISTING: 'Sponsored Search',
};

/** The placements the form offers: every one the contract has. */
export const AD_SLOTS_ON_SALE: readonly AdSlot[] = adSlots;

export const AD_BILLING_LABELS: Readonly<Record<AdBillingModel, string>> = {
  FLAT_RATE: 'Flat rate',
  PER_ORDER_PREMIUM: 'Per-order premium',
};

/** The form's fields, as typed. */
export interface AdProductFormValues {
  readonly name: string;
  readonly slot: AdSlot;
  readonly billingModel: AdBillingModel;
  readonly price: string;
  readonly durationDays: string;
  readonly isActive: boolean;
}

export type AdProductFormField = 'name' | 'price' | 'durationDays';

export function emptyAdProductForm(): AdProductFormValues {
  return {
    name: '',
    slot: 'CAROUSEL',
    billingModel: 'FLAT_RATE',
    price: '',
    durationDays: '7',
    isActive: true,
  };
}

export function formFromAdProduct(product: AdProductView): AdProductFormValues {
  return {
    name: product.name,
    slot: product.slot,
    billingModel: product.billing_model,
    price: String(product.price_npr),
    durationDays: String(product.duration_days),
    isActive: product.is_active,
  };
}

/** The label of the price field, which follows the billing model. Both are NPR amounts. */
export const PRICE_FIELD_LABELS: Readonly<Record<AdBillingModel, string>> = {
  FLAT_RATE: 'Price for the whole period (NPR)',
  PER_ORDER_PREMIUM: 'Fee per delivered order (NPR)',
};

/** "Rs. 5,000 for 7 days" / "Rs. 15 per delivered order, for 30 days". */
export function adPriceLabel(
  product: Pick<AdProductView, 'billing_model' | 'price_npr' | 'duration_days'>,
): string {
  const days = `${String(product.duration_days)} day${product.duration_days === 1 ? '' : 's'}`;
  return product.billing_model === 'FLAT_RATE'
    ? `${formatNpr(product.price_npr)} for ${days}`
    : `${formatNpr(product.price_npr)} per delivered order, for ${days}`;
}

/** What taking a product off sale does to the purchases already running, or null when none are. */
export function offSaleNote(editing: AdProductView | null): string | null {
  if (editing === null || editing.active_purchase_count === 0) return null;
  const count = editing.active_purchase_count;
  return `Taking it off sale stops new purchases. The ${String(count)} running purchase${count === 1 ? ' continues' : 's continue'} to the end, at the price agreed.`;
}

type Errors = Readonly<Partial<Record<AdProductFormField, string>>>;

export type AdProductCreateResult =
  | { readonly ok: true; readonly request: AdProductCreate }
  | { readonly ok: false; readonly errors: Errors };

export type AdProductUpdateResult =
  | { readonly ok: true; readonly request: AdProductUpdate }
  | { readonly ok: false; readonly errors: Errors };

const FIELD_OF_PATH: Readonly<Record<string, AdProductFormField>> = {
  name: 'name',
  price_npr: 'price',
  duration_days: 'durationDays',
};

const FIELD_MESSAGES: Readonly<Record<AdProductFormField, string>> = {
  name: 'Enter a name of at most 80 characters.',
  price: 'Enter an amount above 0, with at most two decimals.',
  durationDays: 'Enter a whole number of days, from 1 to 90.',
};

/** A typed number with at most two decimals; anything else is NaN, which the schema refuses. */
function parseNumber(text: string): number {
  const trimmed = text.trim();
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function errorsOf(issues: readonly { readonly path: readonly PropertyKey[] }[]): Errors {
  const errors: Partial<Record<AdProductFormField, string>> = {};
  for (const issue of issues) {
    const field = FIELD_OF_PATH[String(issue.path[0])];
    if (field !== undefined) errors[field] = FIELD_MESSAGES[field];
  }
  return errors;
}

/** Checks a new product with the request schema, so the screen and the server cannot disagree. */
export function validateNewAdProduct(values: AdProductFormValues): AdProductCreateResult {
  const parsed = adProductCreateRequestSchema.safeParse({
    name: values.name,
    slot: values.slot,
    billing_model: values.billingModel,
    price_npr: parseNumber(values.price),
    duration_days: parseNumber(values.durationDays),
    is_active: values.isActive,
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, errors: errorsOf(parsed.error.issues) };
}

/** Checks an edit: only the name and "on sale" are sent, whatever else the form holds. */
export function validateAdProductEdit(values: AdProductFormValues): AdProductUpdateResult {
  const parsed = adProductUpdateRequestSchema.safeParse({
    name: values.name,
    is_active: values.isActive,
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, errors: errorsOf(parsed.error.issues) };
}

/** On sale first; then by placement, then by name. */
export function adProductRows(products: readonly AdProductView[]): AdProductView[] {
  return [...products].sort(
    (a, b) =>
      Number(b.is_active) - Number(a.is_active) ||
      adSlots.indexOf(a.slot) - adSlots.indexOf(b.slot) ||
      a.name.localeCompare(b.name) ||
      a.price_npr - b.price_npr,
  );
}

export function adProductSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'AD_PRODUCT_NOT_FOUND':
        return 'This ad product no longer exists. Close and refresh the list.';
      case 'VALIDATION_FAILED':
        return 'The server refused this ad product. Check the fields.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The ad product could not be saved. Try again.';
}

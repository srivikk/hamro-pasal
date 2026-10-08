import {
  adminPromotionViewSchema,
  MAX_DISCOUNT_TAG_LENGTH,
  MAX_PROMOTION_DISPLAY_ORDER,
  promotionPlacements,
  promotionPlacementSchema,
  promotionTargetTypes,
  promotionTargetTypeSchema,
  promotionWriteRequestSchema,
  type AdminPromotionView,
  type PromotionPlacement,
  type PromotionTargetType,
  type PromotionWrite,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { nepalDay, nepalInstant } from '../campaigns/campaign-rules';

/**
 * The contract of GET / POST / PUT / DELETE /api/admin/promotions lives in
 * `@hamro-pasal/shared-types` (`api/admin-marketing.ts`) since the API serves it (Phase 26); the
 * form's rules below are built on it. Re-exported so the screen and its tests keep one import.
 * The customer app already reads this shape (`apps/mobile/src/features/promo/promo-model.ts`).
 */
export {
  adminPromotionViewSchema,
  MAX_DISCOUNT_TAG_LENGTH,
  promotionPlacements,
  promotionPlacementSchema,
  promotionTargetTypes,
  promotionTargetTypeSchema,
  promotionWriteRequestSchema,
};
export type { AdminPromotionView, PromotionPlacement, PromotionTargetType, PromotionWrite };

export const MAX_DISPLAY_ORDER = MAX_PROMOTION_DISPLAY_ORDER;

export const PROMOTION_PLACEMENT_LABELS: Readonly<Record<PromotionPlacement, string>> = {
  CAROUSEL: 'Banner carousel',
  FEATURED: 'Featured offers',
};

export const PROMOTION_TARGET_LABELS: Readonly<Record<PromotionTargetType, string>> = {
  SHOP: 'Shop',
  CATEGORY: 'Category',
  DISCOUNT_TAG: 'Discount tag',
};

/** The form's fields, as typed. `targetType` '' is "no target"; days are Nepal Time days. */
/**
 * Whether the form offers sponsorship. Off: `ad_purchases` does not exist yet (BACKEND_CHECKLIST
 * section 5 step 5), the database refuses every sponsored promotion, and naming a purchase can
 * only answer 422 AD_PURCHASE_MISMATCH. The rules below already handle a purchase id; switch
 * this on with the purchase flow and the input returns.
 */
export const SPONSORSHIP_AVAILABLE = false as boolean;

export interface PromotionFormValues {
  readonly placement: PromotionPlacement;
  readonly title: string;
  readonly subtitle: string;
  readonly imageUrl: string;
  readonly targetType: PromotionTargetType | '';
  readonly targetValue: string;
  readonly displayOrder: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly adPurchaseId: string;
  readonly isActive: boolean;
}

export type PromotionFormField =
  | 'title'
  | 'subtitle'
  | 'imageUrl'
  | 'targetValue'
  | 'displayOrder'
  | 'startsOn'
  | 'endsOn'
  | 'adPurchaseId';

export function emptyPromotionForm(): PromotionFormValues {
  return {
    placement: 'CAROUSEL',
    title: '',
    subtitle: '',
    imageUrl: '',
    targetType: 'SHOP',
    targetValue: '',
    displayOrder: '0',
    startsOn: '',
    endsOn: '',
    adPurchaseId: '',
    isActive: true,
  };
}

export function formFromPromotion(promotion: AdminPromotionView): PromotionFormValues {
  return {
    placement: promotion.placement,
    title: promotion.title ?? '',
    subtitle: promotion.subtitle ?? '',
    imageUrl: promotion.image_url ?? '',
    targetType: promotion.target_type ?? '',
    targetValue: promotion.target_value ?? '',
    displayOrder: String(promotion.display_order),
    startsOn: promotion.starts_at === null ? '' : nepalDay(promotion.starts_at),
    endsOn: promotion.ends_at === null ? '' : nepalDay(promotion.ends_at),
    adPurchaseId: promotion.ad_purchase_id ?? '',
    isActive: promotion.is_active,
  };
}

/** The label, placeholder and hint of the target field, which follow the target type. */
export const TARGET_FIELD: Readonly<
  Record<
    PromotionTargetType,
    { readonly label: string; readonly placeholder: string; readonly hint: string }
  >
> = {
  SHOP: {
    label: 'Shop ID',
    placeholder: '00000000-0000-4000-8000-000000000000',
    hint: 'The id of a LIVE shop (Vendors tab). Tapping opens the shop.',
  },
  CATEGORY: {
    label: 'Category slug',
    placeholder: 'festive',
    hint: 'The slug of an active category (Categories tab). Tapping filters Home to its shops.',
  },
  DISCOUNT_TAG: {
    label: 'Discount tag',
    placeholder: '10% OFF',
    hint: 'An offer label. Tapping filters Home to the shops that carry it. It changes no price.',
  },
};

const TARGET_MESSAGES: Readonly<Record<PromotionTargetType, string>> = {
  SHOP: 'Enter the shop’s id (a UUID).',
  CATEGORY: 'Enter a category slug: lower-case words joined by hyphens.',
  DISCOUNT_TAG: `Enter an offer label of at most ${String(MAX_DISCOUNT_TAG_LENGTH)} characters.`,
};

/** Changing the target type empties the value: a shop id is not a category slug. */
export function withTargetType(
  values: PromotionFormValues,
  targetType: PromotionTargetType | '',
): PromotionFormValues {
  return values.targetType === targetType ? values : { ...values, targetType, targetValue: '' };
}

export type PromotionFormResult =
  | { readonly ok: true; readonly request: PromotionWrite }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<PromotionFormField, string>>>;
    };

const blankToNull = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** A typed day as an instant, null when empty, '' (which the schema refuses) when it is no day. */
function dayOrNull(day: string, edge: 'start' | 'end'): string | null {
  return day.trim() === '' ? null : nepalInstant(day, edge);
}

/** Checks the form with the request schema, so the screen and the server cannot disagree. */
export function validatePromotionForm(values: PromotionFormValues): PromotionFormResult {
  const order = values.displayOrder.trim();
  const adPurchaseId = blankToNull(values.adPurchaseId);
  const targetType = values.targetType === '' ? null : values.targetType;
  const parsed = promotionWriteRequestSchema.safeParse({
    placement: values.placement,
    image_url: blankToNull(values.imageUrl),
    title: blankToNull(values.title),
    subtitle: blankToNull(values.subtitle),
    target_type: targetType,
    target_value: targetType === null ? null : values.targetValue.trim(),
    // Not a whole number: NaN fails the schema's integer check.
    display_order: /^\d+$/.test(order) ? Number(order) : Number.NaN,
    is_active: values.isActive,
    starts_at: dayOrNull(values.startsOn, 'start'),
    ends_at: dayOrNull(values.endsOn, 'end'),
    is_sponsored: adPurchaseId !== null,
    ad_purchase_id: adPurchaseId,
  });
  if (parsed.success) return { ok: true, request: parsed.data };

  const sponsored = adPurchaseId !== null;
  const errors: Partial<Record<PromotionFormField, string>> = {};
  for (const issue of parsed.error.issues) {
    switch (issue.path[0]) {
      case 'title':
        errors.title =
          values.placement === 'FEATURED' && blankToNull(values.title) === null
            ? 'A featured offer needs a title.'
            : 'Enter a title of at most 60 characters.';
        break;
      case 'subtitle':
        errors.subtitle = 'Enter a subtitle of at most 80 characters, or leave it empty.';
        break;
      case 'image_url':
        errors.imageUrl =
          values.placement === 'CAROUSEL' && blankToNull(values.imageUrl) === null
            ? 'A carousel banner needs its image.'
            : 'Enter a full http(s) address.';
        break;
      case 'target_value':
        errors.targetValue =
          sponsored && targetType !== 'SHOP'
            ? 'A sponsored promotion must target the shop that bought it.'
            : targetType === null
              ? 'Choose a target type.'
              : TARGET_MESSAGES[targetType];
        break;
      case 'display_order':
        errors.displayOrder = `Enter a whole number from 0 to ${String(MAX_DISPLAY_ORDER)}.`;
        break;
      case 'starts_at':
        errors.startsOn = 'Choose a day, or leave it empty to start now.';
        break;
      case 'ends_at':
        errors.endsOn = 'Choose a day on or after the first day, or leave it empty.';
        break;
      case 'ad_purchase_id':
        errors.adPurchaseId = 'Enter the ad purchase id (a UUID), or leave it empty.';
        break;
      default:
        break;
    }
  }
  return { ok: false, errors };
}

export const PROMOTION_PHASES = ['HIDDEN', 'SCHEDULED', 'LIVE', 'ENDED'] as const;
export type PromotionPhase = (typeof PROMOTION_PHASES)[number];

export const PROMOTION_PHASE_LABELS: Readonly<Record<PromotionPhase, string>> = {
  HIDDEN: 'Hidden',
  SCHEDULED: 'Scheduled',
  LIVE: 'Live',
  ENDED: 'Ended',
};

/** Whether customers see it now: active and inside its dates (what the public read returns). */
export function promotionPhase(promotion: AdminPromotionView, now: string): PromotionPhase {
  if (promotion.ends_at !== null && promotion.ends_at <= now) return 'ENDED';
  if (!promotion.is_active) return 'HIDDEN';
  return promotion.starts_at !== null && promotion.starts_at > now ? 'SCHEDULED' : 'LIVE';
}

/** "Shop · 1000…0007" / "Category · festive" / "Not tappable". */
export function targetLabel(
  promotion: Pick<AdminPromotionView, 'target_type' | 'target_value'>,
): string {
  if (promotion.target_type === null || promotion.target_value === null) return 'Not tappable';
  return `${PROMOTION_TARGET_LABELS[promotion.target_type]} · ${promotion.target_value}`;
}

/** The order the customer app shows them in: by placement, then `display_order`, then age. */
export function promotionRows(promotions: readonly AdminPromotionView[]): AdminPromotionView[] {
  return [...promotions].sort(
    (a, b) =>
      promotionPlacements.indexOf(a.placement) - promotionPlacements.indexOf(b.placement) ||
      a.display_order - b.display_order ||
      a.created_at.localeCompare(b.created_at),
  );
}

/** Showing or hiding: every field as it is, with `is_active` flipped (PUT replaces the row). */
export function visibilityRequest(
  promotion: AdminPromotionView,
  isActive: boolean,
): PromotionWrite {
  return {
    placement: promotion.placement,
    image_url: promotion.image_url,
    title: promotion.title,
    subtitle: promotion.subtitle,
    target_type: promotion.target_type,
    target_value: promotion.target_value,
    display_order: promotion.display_order,
    is_active: isActive,
    starts_at: promotion.starts_at,
    ends_at: promotion.ends_at,
    is_sponsored: promotion.is_sponsored,
    ad_purchase_id: promotion.ad_purchase_id,
  };
}

/** A refused save, placed on the field it is about, or on the form when no field can fix it. */
export interface PromotionSaveError {
  readonly field: PromotionFormField | null;
  readonly message: string;
}

const TARGET_NOT_FOUND_MESSAGES: Readonly<Record<PromotionTargetType, string>> = {
  SHOP: 'No LIVE shop has this id.',
  CATEGORY: 'No active category has this slug (its parent categories must be active too).',
  DISCOUNT_TAG: 'This offer label was refused.',
};

/** The server's refusals of POST / PUT /api/admin/promotions. */
export function promotionSaveError(
  error: unknown,
  targetType: PromotionTargetType | '',
): PromotionSaveError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PROMOTION_TARGET_NOT_FOUND':
        return {
          field: 'targetValue',
          message:
            targetType === '' ? 'The target was not found.' : TARGET_NOT_FOUND_MESSAGES[targetType],
        };
      case 'AD_PURCHASE_REQUIRED':
      case 'AD_PURCHASE_MISMATCH':
        return {
          field: null,
          message: 'Sponsored promotions are not available yet: no vendor can buy an ad.',
        };
      case 'PROMOTION_NOT_FOUND':
        return {
          field: null,
          message: 'This promotion no longer exists. Close and refresh the list.',
        };
      case 'VALIDATION_FAILED':
        return { field: null, message: 'The server refused this promotion. Check the fields.' };
      case 'NETWORK_ERROR':
        return { field: null, message: 'The API cannot be reached. Try again.' };
      default:
        break;
    }
  }
  return { field: null, message: 'The promotion could not be saved. Try again.' };
}

/** A failed Hide, Show or Delete from a row. */
export function promotionActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'PROMOTION_NOT_FOUND') {
    return 'That promotion no longer exists. The list has been refreshed.';
  }
  return promotionSaveError(error, '').message;
}

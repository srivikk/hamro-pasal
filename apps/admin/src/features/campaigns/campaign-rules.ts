import {
  adminCampaignViewSchema,
  campaignWriteRequestSchema,
  discountKinds,
  discountKindSchema,
  type AdminCampaignView,
  type CampaignWrite,
  type DiscountKind,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatDateTime, formatNpr } from '../../lib/format';

/**
 * The contract of GET / POST / PUT /api/admin/campaigns lives in `@hamro-pasal/shared-types`
 * (`api/admin-marketing.ts`) since the API serves it (Phase 26); the form's rules below are built
 * on it. Re-exported so the screen and its tests keep one import.
 *
 * The write schema is strict on purpose: there is no vendor, shop or opt-in key, and no
 * `terms_version`. An admin publishes a campaign; only a shop's own account opts it in.
 */
export { adminCampaignViewSchema, campaignWriteRequestSchema, discountKinds, discountKindSchema };
export type { AdminCampaignView, CampaignWrite, DiscountKind };

/** The form's fields, as typed. Dates are calendar days in Nepal Time (YYYY-MM-DD). */
export interface CampaignFormValues {
  readonly name: string;
  readonly kind: DiscountKind;
  readonly value: string;
  readonly maxDiscount: string;
  readonly minCart: string;
  readonly vendorSharePercent: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly isActive: boolean;
}

export type CampaignFormField =
  'name' | 'value' | 'maxDiscount' | 'minCart' | 'vendorSharePercent' | 'startsOn' | 'endsOn';

/** A new campaign starts unpublished, fully funded by the platform. */
export function emptyCampaignForm(): CampaignFormValues {
  return {
    name: '',
    kind: 'PERCENTAGE',
    value: '',
    maxDiscount: '',
    minCart: '0',
    vendorSharePercent: '0',
    startsOn: '',
    endsOn: '',
    isActive: false,
  };
}

export function formFromCampaign(campaign: AdminCampaignView): CampaignFormValues {
  return {
    name: campaign.name,
    kind: campaign.kind,
    value: String(campaign.value),
    maxDiscount: campaign.max_discount_npr === null ? '' : String(campaign.max_discount_npr),
    minCart: String(campaign.min_cart_npr),
    vendorSharePercent: String(campaign.vendor_share_percent),
    startsOn: nepalDay(campaign.starts_at),
    endsOn: nepalDay(campaign.ends_at),
    isActive: campaign.is_active,
  };
}

/** The calendar day of an instant in Nepal Time. */
export function nepalDay(iso: string): string {
  return formatDateTime(iso).slice(0, 10);
}

/** A typed amount with at most two decimals; anything else is NaN, which the schema refuses. */
function parseAmount(text: string): number {
  const trimmed = text.trim();
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The first or last second of a Nepal Time (UTC+05:45) day, or '' for a day that does not exist. */
export function nepalInstant(day: string, edge: 'start' | 'end'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T${edge === 'start' ? '00:00:00' : '23:59:59'}+05:45`);
  // The engine rolls 30 February over into March: the day must read back as typed.
  if (Number.isNaN(date.getTime()) || nepalDay(date.toISOString()) !== day) return '';
  return date.toISOString();
}

const FIELD_OF_PATH: Readonly<Record<string, CampaignFormField>> = {
  name: 'name',
  value: 'value',
  max_discount_npr: 'maxDiscount',
  min_cart_npr: 'minCart',
  vendor_share_percent: 'vendorSharePercent',
  starts_at: 'startsOn',
  ends_at: 'endsOn',
};

function fieldMessage(field: CampaignFormField, kind: DiscountKind): string {
  switch (field) {
    case 'name':
      return 'Enter a name of at most 80 characters.';
    case 'value':
      return kind === 'PERCENTAGE'
        ? 'Enter a percentage above 0, up to 100.'
        : 'Enter an amount above 0.';
    case 'maxDiscount':
      return 'Enter an amount above 0, or leave it empty for no cap.';
    case 'minCart':
      return 'Enter an amount of 0 or more.';
    case 'vendorSharePercent':
      return 'Enter a percentage from 0 to 100.';
    case 'startsOn':
      return 'Choose the first day.';
    case 'endsOn':
      return 'Choose a last day on or after the first day.';
  }
}

export type CampaignFormResult =
  | { readonly ok: true; readonly request: CampaignWrite }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<CampaignFormField, string>>> };

/** Checks the form with the request schema, so the screen and the server cannot disagree. */
export function validateCampaignForm(values: CampaignFormValues): CampaignFormResult {
  const parsed = campaignWriteRequestSchema.safeParse({
    name: values.name,
    kind: values.kind,
    value: parseAmount(values.value),
    // The cap field is hidden for a flat discount; whatever it held is not sent.
    max_discount_npr:
      values.kind === 'FLAT' || values.maxDiscount.trim() === ''
        ? null
        : parseAmount(values.maxDiscount),
    min_cart_npr: parseAmount(values.minCart),
    vendor_share_percent: parseAmount(values.vendorSharePercent),
    starts_at: nepalInstant(values.startsOn, 'start'),
    ends_at: nepalInstant(values.endsOn, 'end'),
    is_active: values.isActive,
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const errors: Partial<Record<CampaignFormField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = FIELD_OF_PATH[String(issue.path[0])];
    if (field !== undefined) errors[field] = fieldMessage(field, values.kind);
  }
  return { ok: false, errors };
}

/**
 * Whether an edit changes what vendors agreed to: the discount rule, the vendor's share and the
 * dates (decided 2026-10-07: a shop plans its stock around the dates, so moving either one is a
 * change of terms). The server lets these change only together with `terms_version + 1`. The name
 * and publishing are not terms.
 */
export function termsChanged(campaign: AdminCampaignView, request: CampaignWrite): boolean {
  return (
    campaign.kind !== request.kind ||
    campaign.value !== request.value ||
    campaign.max_discount_npr !== request.max_discount_npr ||
    campaign.min_cart_npr !== request.min_cart_npr ||
    campaign.vendor_share_percent !== request.vendor_share_percent ||
    campaign.starts_at !== request.starts_at ||
    campaign.ends_at !== request.ends_at
  );
}

/** The warning shown before an edit that voids opt-ins, or null when the terms are unchanged. */
export function termsChangeWarning(
  campaign: AdminCampaignView,
  request: CampaignWrite,
): string | null {
  if (!termsChanged(campaign, request)) return null;
  const next = campaign.terms_version + 1;
  const count = campaign.opt_in_count;
  const effect =
    count === 0
      ? 'No shop has opted in yet.'
      : `${String(count)} shop${count === 1 ? '' : 's'} opted in to version ${String(campaign.terms_version)}: ${count === 1 ? 'its opt-in is' : 'their opt-ins are'} closed and the campaign stops applying to ${count === 1 ? 'it' : 'them'} until ${count === 1 ? 'it opts' : 'they opt'} in again.`;
  return `These changes raise the terms to version ${String(next)}. ${effect} Orders already priced keep their terms.`;
}

/** Publishing or unpublishing: the same terms with `is_active` flipped, so no opt-in is voided. */
export function publishRequest(campaign: AdminCampaignView, isActive: boolean): CampaignWrite {
  return {
    name: campaign.name,
    kind: campaign.kind,
    value: campaign.value,
    max_discount_npr: campaign.max_discount_npr,
    min_cart_npr: campaign.min_cart_npr,
    vendor_share_percent: campaign.vendor_share_percent,
    starts_at: campaign.starts_at,
    ends_at: campaign.ends_at,
    is_active: isActive,
  };
}

export const CAMPAIGN_PHASES = ['UNPUBLISHED', 'SCHEDULED', 'OPEN', 'ENDED'] as const;
export type CampaignPhase = (typeof CAMPAIGN_PHASES)[number];

export function campaignPhase(campaign: AdminCampaignView, now: string): CampaignPhase {
  if (campaign.ends_at <= now) return 'ENDED';
  if (!campaign.is_active) return 'UNPUBLISHED';
  return campaign.starts_at > now ? 'SCHEDULED' : 'OPEN';
}

export const CAMPAIGN_PHASE_LABELS: Readonly<Record<CampaignPhase, string>> = {
  UNPUBLISHED: 'Unpublished',
  SCHEDULED: 'Published · not started',
  OPEN: 'Published · running',
  ENDED: 'Ended',
};

/** "10% off, up to Rs. 150" / "Rs. 100 off". */
export function discountLabel(
  campaign: Pick<AdminCampaignView, 'kind' | 'value' | 'max_discount_npr'>,
): string {
  if (campaign.kind === 'FLAT') return `${formatNpr(campaign.value)} off`;
  const cap =
    campaign.max_discount_npr === null ? '' : `, up to ${formatNpr(campaign.max_discount_npr)}`;
  return `${String(campaign.value)}% off${cap}`;
}

/** "Vendor bears 50% · platform funds 50%". */
export function fundingLabel(vendorSharePercent: number): string {
  if (vendorSharePercent === 0) return 'Platform funds 100%';
  if (vendorSharePercent === 100) return 'Vendor bears 100%';
  const platform = Math.round((100 - vendorSharePercent) * 100) / 100;
  return `Vendor bears ${String(vendorSharePercent)}% · platform funds ${String(platform)}%`;
}

export function campaignSaveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'CAMPAIGN_NOT_FOUND':
        return 'This campaign no longer exists. Close and refresh the list.';
      case 'VALIDATION_FAILED':
        return 'The server refused this campaign. Check the fields.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The campaign could not be saved. Try again.';
}

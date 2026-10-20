import {
  adminVendorCreateRequestSchema,
  tutorialWriteRequestSchema,
  type AdminVendorCreateRequest,
  type AdminVendorView,
  type TutorialView,
  type TutorialWriteRequest,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/* Steps 7.7 / 7.8: the rules of the Onboarding and Tutorials tabs, unit tested. */

export interface ShopDraft {
  /** The 10 digits after +977, as typed. */
  readonly phone: string;
  readonly businessName: string;
  readonly palika: string;
  readonly lat: string;
  readonly lng: string;
  readonly fulfillment: 'SELF_DELIVERY' | 'PLATFORM_FLEET';
  readonly approveNow: boolean;
}

export type DraftResult<T> =
  { readonly ok: true; readonly request: T } | { readonly ok: false; readonly error: string };

/** `9800000001`, `+977 980-000-0001` -> `+9779800000001`; anything else stays as typed. */
export function nepalPhone(input: string): string {
  const digits = input.replace(/[^\d]/g, '').replace(/^977/, '');
  return `+977${digits}`;
}

export function validateShopDraft(draft: ShopDraft): DraftResult<AdminVendorCreateRequest> {
  const parsed = adminVendorCreateRequestSchema.safeParse({
    phone: nepalPhone(draft.phone),
    business_name: draft.businessName,
    municipality_palika_string: draft.palika,
    location: { lat: Number(draft.lat), lng: Number(draft.lng) },
    fulfillment_mode: draft.fulfillment,
    status: draft.approveNow ? 'APPROVED' : 'SANDBOXED',
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  const messages: Record<string, string> = {
    phone: 'Enter a 10-digit Nepal mobile number starting with 9.',
    business_name: 'Enter the shop name (2–100 characters).',
    municipality_palika_string: 'Enter the municipality / Palika.',
    location: 'Enter the shop’s latitude and longitude, inside Nepal.',
  };
  return { ok: false, error: messages[field] ?? 'The shop cannot be created as entered.' };
}

/**
 * Shops waiting for review, oldest first: SANDBOXED, and APPROVED shops left there by the earlier
 * rule (approval now takes a shop LIVE; one approved before 2026-10-20 never went further).
 */
export function sandboxedShops(vendors: readonly AdminVendorView[]): AdminVendorView[] {
  return vendors
    .filter((vendor) => vendor.status === 'SANDBOXED' || vendor.status === 'APPROVED')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function onboardingErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The request failed.';
  switch (error.code) {
    case 'ALREADY_A_SELLER':
      return 'This number already has a shop.';
    case 'KYC_INCOMPLETE': {
      const missing = (error.details as { missing?: unknown } | undefined)?.missing;
      const names: Record<string, string> = {
        PAN_DOCUMENT: 'PAN document',
        CITIZENSHIP_DOCUMENT: 'citizenship document',
        TAX_ID: 'PAN number',
      };
      const list = Array.isArray(missing)
        ? missing.map((item) => names[String(item)] ?? String(item)).join(', ')
        : 'documents';
      return `Not ready to approve: missing ${list}.`;
    }
    case 'NOT_SANDBOXED':
      return 'This shop is no longer waiting for approval.';
    case 'DEFAULT_PLAN_REQUIRED':
      return 'Publish a default Commission plan (Pricing plans) before approving a shop.';
    case 'NETWORK_ERROR':
      return 'The API cannot be reached.';
    default:
      return 'The request failed.';
  }
}

export interface TutorialDraft {
  readonly app: 'CUSTOMER' | 'SELLER';
  /** A YouTube link or the bare 11-character id. */
  readonly video: string;
  readonly title: string;
  readonly displayOrder: string;
}

/** The video id of a YouTube link (watch, youtu.be, shorts, embed) or of a bare id. */
export function youtubeVideoId(input: string): string | null {
  const text = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  const match =
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(
      text,
    );
  return match?.[1] ?? null;
}

export function validateTutorialDraft(draft: TutorialDraft): DraftResult<TutorialWriteRequest> {
  const id = youtubeVideoId(draft.video);
  if (id === null) return { ok: false, error: 'Paste a YouTube link or an 11-character video id.' };
  const parsed = tutorialWriteRequestSchema.safeParse({
    app: draft.app,
    youtube_video_id: id,
    title: draft.title,
    display_order: draft.displayOrder.trim() === '' ? 0 : Number(draft.displayOrder),
    is_active: true,
  });
  if (parsed.success) return { ok: true, request: parsed.data };
  return {
    ok: false,
    error: 'Give the video a title (up to 80 characters) and a whole-number order.',
  };
}

/** The same video with only `is_active` changed (PUT replaces every field). */
export function toggledTutorial(video: TutorialView): TutorialWriteRequest {
  return {
    app: video.app,
    youtube_video_id: video.youtube_video_id,
    title: video.title,
    display_order: video.display_order,
    is_active: !video.is_active,
  };
}

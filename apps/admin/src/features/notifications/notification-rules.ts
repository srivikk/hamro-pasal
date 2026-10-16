import {
  adminNotificationRequestSchema,
  MAX_ADMIN_NOTIFICATION_VENDORS,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  type AdminNotificationRequest,
  type AdminNotificationView,
  type AdminVendorSearchResult,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/*
 * Step 7.5 (SPEC core 11): the rules of the Notifications tab, kept out of the screen so they are
 * unit tested. The server checks everything again.
 */

export {
  MAX_ADMIN_NOTIFICATION_VENDORS,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
};

export type Audience = AdminNotificationRequest['audience'];

/** A chosen shop, as its chip shows it. */
export type ChosenVendor = Pick<AdminVendorSearchResult, 'id' | 'vendor_code' | 'business_name'>;

/**
 * How a shop is named everywhere on this tab: its business name and its Vendor Code together, so
 * two shops with similar names are never mistaken for each other.
 */
export function vendorLabel(vendor: Pick<ChosenVendor, 'business_name' | 'vendor_code'>): string {
  return `${vendor.business_name} · ${vendor.vendor_code}`;
}

export type AddResult =
  | { readonly ok: true; readonly chosen: readonly ChosenVendor[]; readonly added: number }
  | { readonly ok: false; readonly chosen: readonly ChosenVendor[]; readonly error: string };

/**
 * Adds shops to the selection: each once, in the order chosen, never more than 500. Adding more
 * than room remains adds none of them, so the admin decides which ones to leave out.
 */
export function addVendors(
  chosen: readonly ChosenVendor[],
  candidates: readonly ChosenVendor[],
): AddResult {
  const known = new Set(chosen.map((vendor) => vendor.id));
  const fresh: ChosenVendor[] = [];
  for (const candidate of candidates) {
    if (known.has(candidate.id)) continue;
    known.add(candidate.id);
    fresh.push({
      id: candidate.id,
      vendor_code: candidate.vendor_code,
      business_name: candidate.business_name,
    });
  }
  if (chosen.length + fresh.length > MAX_ADMIN_NOTIFICATION_VENDORS) {
    return {
      ok: false,
      chosen,
      error: `At most ${String(MAX_ADMIN_NOTIFICATION_VENDORS)} shops per message (${String(
        MAX_ADMIN_NOTIFICATION_VENDORS - chosen.length,
      )} more can be added).`,
    };
  }
  return { ok: true, chosen: [...chosen, ...fresh], added: fresh.length };
}

export function removeVendor(chosen: readonly ChosenVendor[], id: string): ChosenVendor[] {
  return chosen.filter((vendor) => vendor.id !== id);
}

/** "12 / 60": characters used of the limit, as the counters under the fields show it. */
export function counter(text: string, max: number): string {
  return `${String(text.trim().length)} / ${String(max)}`;
}

export interface Draft {
  readonly audience: Audience;
  readonly chosen: readonly ChosenVendor[];
  readonly title: string;
  readonly body: string;
  /** Optional app path a tap opens, e.g. `/orders`; blank for none. */
  readonly deepLink: string;
}

export type DraftResult =
  | { readonly ok: true; readonly request: AdminNotificationRequest }
  | { readonly ok: false; readonly error: string };

/** The request to send, or why it cannot be sent yet. */
export function validateDraft(draft: Draft): DraftResult {
  if (draft.audience === 'VENDORS' && draft.chosen.length === 0) {
    return { ok: false, error: 'Choose at least one shop.' };
  }
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (title === '') return { ok: false, error: 'Write a title.' };
  if (title.length > NOTIFICATION_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: `The title is at most ${String(NOTIFICATION_TITLE_MAX_LENGTH)} characters.`,
    };
  }
  if (body === '') return { ok: false, error: 'Write the message.' };
  if (body.length > NOTIFICATION_BODY_MAX_LENGTH) {
    return {
      ok: false,
      error: `The message is at most ${String(NOTIFICATION_BODY_MAX_LENGTH)} characters.`,
    };
  }
  const deepLink = draft.deepLink.trim();
  const common = { title, body, ...(deepLink === '' ? {} : { deep_link: deepLink }) };
  const parsed = adminNotificationRequestSchema.safeParse(
    draft.audience === 'VENDORS'
      ? { audience: 'VENDORS', vendor_ids: draft.chosen.map((vendor) => vendor.id), ...common }
      : { audience: 'ALL_CUSTOMERS', ...common },
  );
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.some((issue) => issue.path[0] === 'deep_link')
        ? 'The link must be an app path starting with /, such as /orders.'
        : 'The message cannot be sent as written.',
    };
  }
  return { ok: true, request: parsed.data };
}

/** What the confirmation asks, naming exactly who will receive it. */
export function confirmationText(draft: Pick<Draft, 'audience' | 'chosen'>): string {
  if (draft.audience === 'ALL_CUSTOMERS') {
    return 'Send to ALL customers? Every customer will see it in their notification centre.';
  }
  const count = draft.chosen.length;
  if (count === 1 && draft.chosen[0] !== undefined) {
    return `Send to 1 shop: ${vendorLabel(draft.chosen[0])}?`;
  }
  return `Send to ${String(count)} shops?`;
}

/** The answer after a send: who it reached. */
export function sentText(audience: Audience, recipientCount: number): string {
  return audience === 'VENDORS'
    ? `Sent to ${String(recipientCount)} shop${recipientCount === 1 ? '' : 's'}.`
    : `Sent to all customers (${String(recipientCount)} accounts).`;
}

/** Why a send was refused, in words the admin can act on. */
export function sendErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return 'The message could not be sent.';
  switch (error.code) {
    case 'NETWORK_ERROR':
      return 'The API cannot be reached. Nothing was sent.';
    case 'BROADCAST_RATE_LIMITED': {
      const details = error.details as { retry_after_seconds?: unknown } | undefined;
      const seconds =
        typeof details?.retry_after_seconds === 'number' ? details.retry_after_seconds : null;
      return seconds === null
        ? 'Only one message to all customers every 10 minutes.'
        : `Only one message to all customers every 10 minutes. Try again in ${String(
            Math.ceil(seconds / 60),
          )} min.`;
    }
    case 'VENDOR_NOT_FOUND':
      return 'Some chosen shops no longer exist. Remove them and send again.';
    case 'VALIDATION_FAILED':
      return 'The message was refused as written. Check the title, the message and the link.';
    default:
      return 'The message could not be sent.';
  }
}

/** The history row's push column. */
export function pushOutcomeText(
  view: Pick<AdminNotificationView, 'push_sent' | 'push_failed' | 'push_completed_at'>,
): string {
  if (view.push_completed_at === null || view.push_sent === null || view.push_failed === null) {
    return 'Pushing…';
  }
  return view.push_failed === 0
    ? `${String(view.push_sent)} devices`
    : `${String(view.push_sent)} devices, ${String(view.push_failed)} failed`;
}

export const AUDIENCE_LABELS: Readonly<Record<AdminNotificationView['audience'], string>> = {
  VENDOR: 'Chosen shops',
  CUSTOMER: 'Customers',
  ALL_CUSTOMERS: 'All customers',
};

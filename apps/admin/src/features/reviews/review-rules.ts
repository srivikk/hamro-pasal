import {
  PRODUCT_REVIEW_HIDE_REASON_MAX_LENGTH,
  PRODUCT_REVIEW_HIDE_REASON_MIN_LENGTH,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';

/*
 * 2026-10-22 (Task 6): the Product reviews screen's rules. A review that breaks platform policy is
 * hidden with a written reason (kept in the audit log) and can be shown again.
 */

export type ReviewFilter = 'ALL' | 'VISIBLE' | 'HIDDEN';

export const REVIEW_FILTERS: readonly { id: ReviewFilter; label: string }[] = [
  { id: 'ALL', label: 'All' },
  { id: 'VISIBLE', label: 'Published' },
  { id: 'HIDDEN', label: 'Hidden' },
];

/** The API's `status` for a filter chip. */
export function statusOf(filter: ReviewFilter): 'VISIBLE' | 'HIDDEN' | undefined {
  return filter === 'ALL' ? undefined : filter;
}

/** "★★★☆☆" for a rating of 3. */
export function stars(rating: number): string {
  const whole = Math.min(5, Math.max(0, Math.round(rating)));
  return '★'.repeat(whole) + '☆'.repeat(5 - whole);
}

/** The reason as the API takes it, or the message to show instead. */
export function checkHideReason(
  reason: string,
): { ok: true; reason: string } | { ok: false; message: string } {
  const trimmed = reason.trim();
  if (
    trimmed.length < PRODUCT_REVIEW_HIDE_REASON_MIN_LENGTH ||
    trimmed.length > PRODUCT_REVIEW_HIDE_REASON_MAX_LENGTH
  ) {
    return {
      ok: false,
      message: `Write which policy the review breaks (${String(PRODUCT_REVIEW_HIDE_REASON_MIN_LENGTH)} to ${String(PRODUCT_REVIEW_HIDE_REASON_MAX_LENGTH)} characters). It is kept in the audit log.`,
    };
  }
  return { ok: true, reason: trimmed };
}

export function reviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PRODUCT_REVIEW_NOT_FOUND':
        return 'That review no longer exists.';
      case 'NETWORK_ERROR':
        return 'No connection to the server. Check the network and try again.';
      default:
        return error.message;
    }
  }
  return 'Something went wrong. Try again.';
}

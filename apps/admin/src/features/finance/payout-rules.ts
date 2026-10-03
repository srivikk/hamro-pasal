import {
  adminPayoutApproveRequestSchema,
  adminPayoutRejectRequestSchema,
  payoutRequestSchema,
  type AdminPayoutListResponseBody,
  type AdminPayoutView,
  type PayoutStatus,
  type VendorFinanceLedgerResponseBody,
} from '@hamro-pasal/shared-types';
import type { InfiniteData } from '@tanstack/react-query';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

export const PAYOUT_STATUS_LABELS: Readonly<Record<PayoutStatus, string>> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const PAYOUT_FILTERS: readonly {
  readonly label: string;
  readonly status: PayoutStatus | undefined;
}[] = [
  { label: 'Pending', status: 'PENDING' },
  { label: 'Approved', status: 'APPROVED' },
  { label: 'Rejected', status: 'REJECTED' },
  { label: 'All', status: undefined },
];

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** The bank reference an approval must carry, checked with the API's own schema. */
export function parseBankReference(input: string): Parsed<string> {
  const result = adminPayoutApproveRequestSchema.safeParse({ bank_reference: input });
  if (result.success) return { ok: true, value: result.data.bank_reference };
  return {
    ok: false,
    error:
      input.trim() === ''
        ? 'Enter the reference of the bank transfer.'
        : 'The bank reference is too long (100 characters at most).',
  };
}

/** An optional reason; blank means none. */
export function parseRejectionReason(input: string): Parsed<string | null> {
  const result = adminPayoutRejectRequestSchema.safeParse({ reason: input });
  if (result.success) return { ok: true, value: result.data.reason };
  return { ok: false, error: 'The reason is too long (500 characters at most).' };
}

/**
 * The amount a vendor typed, checked with the API's schema and against the balance shown. The server
 * decides again under its lock: this only saves a round trip.
 */
export function parsePayoutAmount(input: string, availableBalanceNpr: number): Parsed<number> {
  const text = input.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: 'Enter an amount in rupees, for example 1500 or 1500.50.' };
  }
  const amount = Number(text);
  const result = payoutRequestSchema.shape.amount_npr.safeParse(amount);
  if (!result.success) {
    return {
      ok: false,
      error: amount <= 0 ? 'Enter an amount above zero.' : 'That is more than one payout allows.',
    };
  }
  if (amount > availableBalanceNpr) {
    return {
      ok: false,
      error: `You can withdraw at most ${formatNpr(Math.max(availableBalanceNpr, 0))}.`,
    };
  }
  return { ok: true, value: amount };
}

/** A payout can be requested only from a positive balance. */
export function canRequestPayout(ledger: VendorFinanceLedgerResponseBody): boolean {
  return ledger.available_balance_npr > 0;
}

export function payoutRequestErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INSUFFICIENT_BALANCE':
        return 'Your balance is lower than that now. The figures have been refreshed.';
      case 'IDEMPOTENCY_KEY_REUSED':
        return 'This request was already sent with another amount. Try again.';
      case 'VALIDATION_FAILED':
        return 'That amount is not valid.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again: the request will not be made twice.';
      default:
        break;
    }
  }
  return 'The payout could not be requested. Try again.';
}

export function payoutDecisionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PAYOUT_ALREADY_DECIDED':
        return 'This request was already decided. The list has been refreshed.';
      case 'PAYOUT_NOT_FOUND':
        return 'This request no longer exists.';
      case 'VALIDATION_FAILED':
        return 'Check the bank reference or the reason.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The decision could not be saved. Try again.';
}

/** Shows a decided request in every cached page at once (the refetch then confirms it). */
export function replacePayout(
  data: InfiniteData<AdminPayoutListResponseBody, string | undefined> | undefined,
  payout: AdminPayoutView,
): InfiniteData<AdminPayoutListResponseBody, string | undefined> | undefined {
  if (data === undefined) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      payouts: page.payouts.map((current) => (current.id === payout.id ? payout : current)),
    })),
  };
}

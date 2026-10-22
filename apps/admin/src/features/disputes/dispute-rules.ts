import {
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_NOTE_MIN_LENGTH,
  resolutionRequestSchema,
  type AdminDisputeView,
  type ResolutionOutcome,
  type ResolutionRequest,
} from '@hamro-pasal/shared-types';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

/*
 * 2026-10-21 (Task 5): the Disputes screen's rules. An escalated order's money stays frozen (the
 * vendor's dispute hold; never paid out, never released on day 8) until the Super Admin resolves
 * it here: release it to the shop, refund the customer in full, or refund part and release the
 * rest (SPEC core 6).
 */

export interface ResolutionForm {
  readonly outcome: ResolutionOutcome;
  /** PARTIAL_REFUND only, as typed. */
  readonly refund: string;
  readonly note: string;
}

export const EMPTY_RESOLUTION: ResolutionForm = { outcome: 'RELEASE', refund: '', note: '' };

export const OUTCOME_LABELS: Readonly<Record<ResolutionOutcome, string>> = {
  RELEASE: 'Release to the shop',
  REFUND: 'Refund the customer in full',
  PARTIAL_REFUND: 'Refund part, release the rest',
};

export type ResolutionResult =
  | { readonly ok: true; readonly request: ResolutionRequest }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<'refund' | 'note', string>>> };

/**
 * Checks the form with the API's own schema, plus the one rule it cannot know: a partial refund
 * is less than what the customer paid.
 */
export function validateResolution(
  form: ResolutionForm,
  dispute: Pick<AdminDisputeView, 'order_total_npr'>,
): ResolutionResult {
  const refundText = form.refund.trim();
  const refund = /^\d+(\.\d{1,2})?$/.test(refundText) ? Number(refundText) : Number.NaN;
  const parsed = resolutionRequestSchema.safeParse({
    outcome: form.outcome,
    note: form.note,
    ...(form.outcome === 'PARTIAL_REFUND' ? { refund_npr: refund } : {}),
  });
  const errors: Partial<Record<'refund' | 'note', string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === 'note') {
        errors.note = `Write ${String(RESOLUTION_NOTE_MIN_LENGTH)} to ${String(RESOLUTION_NOTE_MAX_LENGTH)} characters: the parties are told this reason.`;
      }
      if (issue.path[0] === 'refund_npr') {
        errors.refund = 'Enter an amount above 0 with at most two decimals.';
      }
    }
  }
  if (
    form.outcome === 'PARTIAL_REFUND' &&
    errors.refund === undefined &&
    !(refund < dispute.order_total_npr)
  ) {
    errors.refund = `A partial refund is less than the ${formatNpr(dispute.order_total_npr)} paid; use a full refund instead.`;
  }
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, request: parsed.data };
}

/** A conversation the Super Admin has settled (released, refunded or partly refunded). */
export function isResolved(status: AdminDisputeView['status']): boolean {
  return (
    status === 'RELEASED_TO_VENDOR' ||
    status === 'REFUNDED_TO_CUSTOMER' ||
    status === 'PARTIALLY_REFUNDED'
  );
}

/** What the money of a dispute is doing now, in one line. */
export function moneyLine(dispute: AdminDisputeView): string {
  if (isResolved(dispute.status)) {
    return dispute.refund_npr === null || dispute.refund_npr === 0
      ? 'Released to the shop.'
      : `Refunded ${formatNpr(dispute.refund_npr)} to the customer.`;
  }
  if (dispute.payment_method === 'COD') {
    return 'Cash on delivery: the shop holds the cash; a refund is debited from its ledger.';
  }
  return dispute.held_npr > 0
    ? `${formatNpr(dispute.held_npr)} frozen in escrow until you resolve this.`
    : 'Nothing is held for this order yet (it is not delivered, or already settled elsewhere).';
}

/** The API's refusals, in words. */
export function disputeErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'DISPUTE_NOT_FOUND':
      case 'ORDER_NOT_FOUND':
      case 'NOT_ESCALATED':
        return 'This dispute is no longer open.';
      case 'ALREADY_RESOLVED':
        return 'Another admin resolved this dispute already. Refresh the list.';
      case 'ORDER_NOT_DELIVERED':
        return 'The order is not delivered yet. Its money stays frozen; resolve it once delivered.';
      case 'REFUND_EXCEEDS_PAYMENT':
        return 'A partial refund is less than what the customer paid; use a full refund instead.';
      case 'NETWORK_ERROR':
        return 'No connection to the server. Check the network and try again.';
      default:
        return error.message;
    }
  }
  return 'Something went wrong. Try again.';
}

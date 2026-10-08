import {
  settlementModels,
  settlementModelSchema,
  settlementPayoutRequestSchema,
  settlementVendorViewSchema,
  type AdminSettlementListResponseBody,
  type SettlementModel,
  type SettlementPayoutRequest,
  type SettlementVendorView,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

/**
 * The contracts of GET /api/admin/finance/settlements and POST …/:vendor_id/payout live in
 * `@hamro-pasal/shared-types` (`api/finance.ts`) since the API serves them (Phase 26).
 * Re-exported so the screen and its tests keep one import.
 */
export {
  settlementModels,
  settlementModelSchema,
  settlementPayoutRequestSchema,
  settlementVendorViewSchema,
};
export type { SettlementModel, SettlementPayoutRequest, SettlementVendorView };

/** The tooltip of a held payout, word for word as the rule was given (2026-10-07). */
export const PAN_NOT_VERIFIED_MESSAGE = 'Cannot disburse funds: PAN not verified.';
export const BANK_ACCOUNT_MISSING_MESSAGE =
  'Cannot disburse funds: the vendor has no primary bank account.';

/** What holds a shop's payout. The server checks them in this order, under the vendor row lock. */
export type PayoutBlocker = 'PAN' | 'BANK';

export const PAYOUT_BLOCKER_MESSAGES: Readonly<Record<PayoutBlocker, string>> = {
  PAN: PAN_NOT_VERIFIED_MESSAGE,
  BANK: BANK_ACCOUNT_MISSING_MESSAGE,
};

export function payoutBlockers(
  vendor: Pick<SettlementVendorView, 'pan_verified_at' | 'primary_bank_account'>,
): PayoutBlocker[] {
  const blockers: PayoutBlocker[] = [];
  if (vendor.pan_verified_at === null) blockers.push('PAN');
  if (vendor.primary_bank_account === null) blockers.push('BANK');
  return blockers;
}

/**
 * The rows of the table: Model B (escrow) shops the platform owes money to now. A shop on another
 * model, or with nothing available, has nothing to approve. Payable shops first, then held ones;
 * the largest amount first within each.
 */
export function payableVendors(vendors: readonly SettlementVendorView[]): SettlementVendorView[] {
  return vendors
    .filter(
      (vendor) =>
        vendor.settlement_model === 'PLATFORM_ESCROW' && vendor.available_for_payout_npr > 0,
    )
    .sort(
      (a, b) =>
        Number(payoutBlockers(a).length > 0) - Number(payoutBlockers(b).length > 0) ||
        b.available_for_payout_npr - a.available_for_payout_npr ||
        a.business_name.localeCompare(b.business_name),
    );
}

export interface PayoutButton {
  readonly enabled: boolean;
  readonly blockers: readonly PayoutBlocker[];
  /** Why the payout is held; shown as the button's tooltip. */
  readonly tooltip: string | null;
}

/**
 * The "Process Payout" button of one row. Two gates: no money is transferred to a shop whose PAN
 * document a Super Admin has not verified, nor to one with no primary bank account to send it to.
 * The shop itself trades meanwhile; only the transfer waits.
 */
export function payoutButton(vendor: SettlementVendorView): PayoutButton {
  const blockers = payoutBlockers(vendor);
  return {
    enabled: blockers.length === 0,
    blockers,
    tooltip:
      blockers.length === 0
        ? null
        : blockers.map((blocker) => PAYOUT_BLOCKER_MESSAGES[blocker]).join(' '),
  };
}

/** What is ready to pay, and what is held behind a gate. */
export function settlementTotals(vendors: readonly SettlementVendorView[]): {
  readonly readyNpr: number;
  readonly heldNpr: number;
  readonly heldCount: number;
} {
  let ready = 0;
  let held = 0;
  let heldCount = 0;
  for (const vendor of payableVendors(vendors)) {
    const paisa = Math.round(vendor.available_for_payout_npr * 100);
    if (payoutBlockers(vendor).length > 0) {
      held += paisa;
      heldCount += 1;
    } else {
      ready += paisa;
    }
  }
  return { readyNpr: ready / 100, heldNpr: held / 100, heldCount };
}

/** The payout form's fields, as typed. */
export interface PayoutFormValues {
  readonly amount: string;
  readonly bankReference: string;
}

export type PayoutFormField = 'amount' | 'bankReference';

/** The form opens on the whole available amount. */
export function payoutFormFor(vendor: SettlementVendorView): PayoutFormValues {
  return { amount: String(vendor.available_for_payout_npr), bankReference: '' };
}

export type PayoutFormResult =
  | { readonly ok: true; readonly request: SettlementPayoutRequest }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<PayoutFormField, string>>>;
      /** A refusal that no field can fix (a gate). */
      readonly blocked: string | null;
    };

/**
 * Checks the payout form: the gates first, then the request schema, then the amount against what
 * is available. `idempotencyKey` is the modal's: one per attempt, the same across its retries.
 */
export function validatePayoutForm(
  vendor: SettlementVendorView,
  values: PayoutFormValues,
  idempotencyKey: string,
): PayoutFormResult {
  const button = payoutButton(vendor);
  if (!button.enabled) return { ok: false, errors: {}, blocked: button.tooltip };

  const amount = values.amount.trim();
  const parsed = settlementPayoutRequestSchema.safeParse({
    // Not an amount with at most two decimals: NaN fails the schema.
    amount_npr: /^\d+(\.\d{1,2})?$/.test(amount) ? Number(amount) : Number.NaN,
    bank_reference: values.bankReference,
    idempotency_key: idempotencyKey,
  });
  const errors: Partial<Record<PayoutFormField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === 'amount_npr') errors.amount = 'Enter an amount above 0.';
      if (issue.path[0] === 'bank_reference') {
        errors.bankReference = 'Enter the reference of the bank transfer, at most 100 characters.';
      }
    }
    // A bad key is the app's fault, not a field's.
    if (Object.keys(errors).length === 0) {
      return { ok: false, errors, blocked: 'The payout could not be prepared. Close and reopen.' };
    }
  } else if (parsed.data.amount_npr > vendor.available_for_payout_npr) {
    errors.amount = `At most ${formatNpr(vendor.available_for_payout_npr)} is available.`;
  }
  if (parsed.success && Object.keys(errors).length === 0) {
    return { ok: true, request: parsed.data };
  }
  return { ok: false, errors, blocked: null };
}

/** A refused payout, placed on the field it is about, or on the form when no field can fix it. */
export interface PayoutSaveError {
  readonly field: PayoutFormField | null;
  readonly message: string;
}

const insufficientDetailsSchema = z.object({ available_balance_npr: z.number() });

/**
 * The server's refusals of the payout. It re-checks every gate and the balance under the vendor
 * row lock, so each can differ from what the list showed when the modal opened.
 */
export function payoutSaveError(error: unknown): PayoutSaveError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PAN_NOT_VERIFIED':
        return { field: null, message: PAN_NOT_VERIFIED_MESSAGE };
      case 'BANK_ACCOUNT_MISSING':
        return { field: null, message: BANK_ACCOUNT_MISSING_MESSAGE };
      case 'INSUFFICIENT_BALANCE': {
        const details = insufficientDetailsSchema.safeParse(error.details);
        return {
          field: 'amount',
          message: details.success
            ? `Only ${formatNpr(details.data.available_balance_npr)} is available now.`
            : 'The amount is more than what is available now.',
        };
      }
      case 'SETTLEMENT_MODEL_NOT_ESCROW':
        return {
          field: null,
          message: 'This shop is no longer on the escrow model: the platform holds nothing to pay.',
        };
      case 'IDEMPOTENCY_KEY_REUSED':
        return {
          field: null,
          message:
            'This attempt was already recorded with another amount or reference. Close this window and check the balance before paying again.',
        };
      case 'VENDOR_NOT_FOUND':
        return { field: null, message: 'This vendor no longer exists.' };
      case 'VALIDATION_FAILED':
        return { field: null, message: 'The server refused this payout. Check the fields.' };
      case 'NETWORK_ERROR':
        return {
          field: null,
          message:
            'The API cannot be reached. Try again: the same attempt is never recorded twice.',
        };
      default:
        break;
    }
  }
  return { field: null, message: 'The payout could not be recorded. Try again.' };
}

/** The cached list with one shop replaced by the server's view of it after its payout. */
export function replaceSettlementVendor(
  list: AdminSettlementListResponseBody,
  vendor: SettlementVendorView,
): AdminSettlementListResponseBody {
  return {
    ...list,
    vendors: list.vendors.map((current) =>
      current.vendor_id === vendor.vendor_id ? vendor : current,
    ),
  };
}

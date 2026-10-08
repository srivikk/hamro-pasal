import {
  adminModelChangeRejectRequestSchema,
  modelChangeBlockers,
  modelChangeBlockersOf,
  modelChangeRequestViewSchema,
  settlementModelRequestStatuses,
  type AdminModelChangeRequestListResponseBody,
  type ModelChangeBlocker,
  type ModelChangeRequestView,
  type SettlementModel,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError } from '../../api/client';
import { formatNpr } from '../../lib/format';

/**
 * The contract of GET /api/admin/settlement-model-requests and POST …/:id/approve | reject lives
 * in `@hamro-pasal/shared-types` (`api/settlement-model-requests.ts`) since the API serves it
 * (Phase 27). Re-exported so the screen and its tests keep one import.
 *
 * Neither decision carries a model: an admin decides the vendor's request as asked and cannot
 * choose another model for the shop.
 */
export { modelChangeBlockers, modelChangeRequestViewSchema };
export type { ModelChangeBlocker, ModelChangeRequestView };

export const modelChangeStatuses = settlementModelRequestStatuses;

export const SETTLEMENT_MODEL_LABELS: Readonly<Record<SettlementModel, string>> = {
  COD_CREDIT: 'Model A · COD credit',
  PLATFORM_ESCROW: 'Model B · Platform escrow',
  DIRECT_PREPAID: 'Model C · Direct prepaid',
};

/**
 * Why a change cannot take effect yet (SPEC core section 5), from the counts the server sent
 * with the request: the shared rule, which the server applies again under the vendor row lock.
 */
export const blockersOf = modelChangeBlockersOf;

function blockerText(
  request: Pick<
    ModelChangeRequestView,
    'open_order_count' | 'ledger_balance_npr' | 'active_ad_count'
  >,
  blocker: ModelChangeBlocker,
): string {
  switch (blocker) {
    case 'OPEN_ORDERS':
      return `${String(request.open_order_count)} open order${request.open_order_count === 1 ? '' : 's'}`;
    case 'NEGATIVE_BALANCE':
      return `ledger at ${formatNpr(request.ledger_balance_npr)} (must be 0 or above)`;
    case 'ACTIVE_AD':
      return `${String(request.active_ad_count)} ad${request.active_ad_count === 1 ? '' : 's'} running`;
  }
}

export interface ApproveButton {
  readonly enabled: boolean;
  /** Why Approve is unavailable, or what approving does. */
  readonly note: string | null;
}

/**
 * The Approve button of one request, mirroring the server's rules so the admin sees why before
 * pressing: the server still decides, under the vendor row lock.
 */
export function approveButton(request: ModelChangeRequestView): ApproveButton {
  if (request.status !== 'PENDING') return { enabled: false, note: null };
  if (request.requested_model === 'DIRECT_PREPAID') {
    return {
      enabled: false,
      note: 'Model C (direct prepaid) cannot be selected before Phase 3. Reject the request.',
    };
  }
  const blockers = blockersOf(request);
  if (blockers.length > 0) {
    return {
      enabled: false,
      note: `Cannot take effect yet: ${blockers.map((blocker) => blockerText(request, blocker)).join('; ')}.`,
    };
  }
  return {
    enabled: true,
    note: 'Applies to new orders at once. Orders already placed settle under the model they were placed with.',
  };
}

export const MODEL_CHANGE_FILTERS: readonly {
  readonly label: string;
  readonly pending: boolean;
}[] = [
  { label: 'Pending', pending: true },
  { label: 'Decided', pending: false },
];

/** Pending: the longest waiting first. Decided: the latest decision first. */
export function modelChangeRows(
  requests: readonly ModelChangeRequestView[],
  pending: boolean,
): ModelChangeRequestView[] {
  return requests
    .filter((request) => (request.status === 'PENDING') === pending)
    .sort((a, b) =>
      pending
        ? a.requested_at.localeCompare(b.requested_at)
        : (b.decided_at ?? '').localeCompare(a.decided_at ?? ''),
    );
}

export type DecisionResult =
  /** `reason` is what a rejection sends; always null for an approval. */
  | { readonly ok: true; readonly reason: string | null }
  | { readonly ok: false; readonly error: string };

/** Checks a decision before it is sent; a blank reason is none. */
export function validateDecision(
  request: ModelChangeRequestView,
  decision: 'APPROVE' | 'REJECT',
  reasonText: string,
): DecisionResult {
  if (request.status !== 'PENDING') {
    return { ok: false, error: 'This request has already been decided.' };
  }
  if (decision === 'APPROVE') {
    const button = approveButton(request);
    if (!button.enabled)
      return { ok: false, error: button.note ?? 'This request cannot be approved.' };
  }
  if (decision === 'APPROVE') return { ok: true, reason: null };
  const parsed = adminModelChangeRejectRequestSchema.safeParse({ reason: reasonText });
  return parsed.success
    ? { ok: true, reason: parsed.data.reason }
    : { ok: false, error: 'Enter a reason of at most 500 characters, or leave it empty.' };
}

const blockedDetailsSchema = z.object({ blockers: z.array(z.enum(modelChangeBlockers)).min(1) });

const BLOCKER_WORDS: Readonly<Record<ModelChangeBlocker, string>> = {
  OPEN_ORDERS: 'open orders',
  NEGATIVE_BALANCE: 'a ledger below 0',
  ACTIVE_AD: 'an ad running',
};

/**
 * The server's refusal of a decision. It reads the guardrails again under the vendor row lock, so
 * a shop that was clear when the list was loaded may be blocked by the time Approve is pressed.
 */
export function decisionErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SETTLEMENT_CHANGE_BLOCKED': {
        const details = blockedDetailsSchema.safeParse(error.details);
        return details.success
          ? `The shop now has ${details.data.blockers.map((blocker) => BLOCKER_WORDS[blocker]).join(', ')}: the change cannot take effect yet. The list has been refreshed.`
          : 'The change cannot take effect yet. The list has been refreshed.';
      }
      case 'SETTLEMENT_MODEL_UNAVAILABLE':
        return 'Model C (direct prepaid) cannot be selected before Phase 3. Reject the request.';
      case 'REQUEST_ALREADY_DECIDED':
        return 'This request has already been decided. The list has been refreshed.';
      case 'SETTLEMENT_MODEL_REQUEST_NOT_FOUND':
        return 'This request no longer exists.';
      case 'NETWORK_ERROR':
        return 'The API cannot be reached. Try again.';
      default:
        break;
    }
  }
  return 'The decision could not be saved. Try again.';
}

/** The cached list with one request replaced by the server's answer to its decision. */
export function replaceModelChangeRequest(
  list: AdminModelChangeRequestListResponseBody,
  request: ModelChangeRequestView,
): AdminModelChangeRequestListResponseBody {
  return {
    ...list,
    requests: list.requests.map((current) => (current.id === request.id ? request : current)),
  };
}

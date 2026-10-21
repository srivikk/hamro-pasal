import {
  bankAccountListResponseSchema,
  bankAccountResponseSchema,
  bankAccountWriteRequestSchema,
  billingChangeResponseSchema,
  gatewayAccountListResponseSchema,
  gatewayAccountResponseSchema,
  gatewayAccountWriteRequestSchema,
  vendorBillingViewSchema,
  type BankAccountListResponseBody,
  type BankAccountResponseBody,
  type BankAccountWrite,
  type BillingChangeRequest,
  type BillingChangeResponseBody,
  type GatewayAccountListResponseBody,
  type GatewayAccountResponseBody,
  type GatewayAccountWriteRequest,
  type GatewayPaymentMethod,
  type VendorBillingView,
} from '@hamro-pasal/shared-types';
import { z } from 'zod';

import { ApiError, apiRequest } from './http';

/*
 * 2026-10-21 (SPEC core 4, 5 and 9): how the shop is paid. Its plan and payment methods (queued
 * for the next Billing Cycle), its own eSewa / Khalti merchant accounts (Model C) and its bank
 * accounts.
 */

export const VENDOR_BILLING_PATH = '/api/vendor/billing';
export const BILLING_CHANGES_PATH = '/api/vendor/billing/changes';
export const GATEWAY_ACCOUNTS_PATH = '/api/vendor/gateway-accounts';
export const BANK_ACCOUNTS_PATH = '/api/vendor/bank-accounts';

/** Codes the Payments screen words itself. */
export const VENDOR_PAYMENTS_ERROR_CODES = {
  /** A Commission or Free plan: only a Super Admin assigns those. */
  adminOnlyPlan: 'PRICING_PLAN_ADMIN_ONLY',
  /** The merchant code is registered to another shop. */
  merchantTaken: 'MERCHANT_ACCOUNT_TAKEN',
  /** Client side: the form broke the contract and was not sent. */
  invalid: 'INVALID_PAYMENT_DETAILS',
} as const;

/** GET /api/vendor/billing: plan, methods, cycle, queued changes, dues and the reserve. */
export function fetchVendorBilling(): Promise<VendorBillingView> {
  return apiRequest({ method: 'GET', path: VENDOR_BILLING_PATH, schema: vendorBillingViewSchema });
}

/**
 * POST /api/vendor/billing/changes: queued for the next Billing Cycle, never applied now. The
 * answer's `change` is null when the request equals the active value.
 */
export function requestBillingChange(
  change: BillingChangeRequest,
): Promise<BillingChangeResponseBody> {
  return apiRequest({
    method: 'POST',
    path: BILLING_CHANGES_PATH,
    body: change,
    schema: billingChangeResponseSchema,
  });
}

/** DELETE /api/vendor/billing/changes/:id: withdraws a queued change (204). */
export function withdrawBillingChange(id: string): Promise<undefined> {
  return apiRequest({
    method: 'DELETE',
    path: `${BILLING_CHANGES_PATH}/${encodeURIComponent(id)}`,
    schema: z.undefined(),
  });
}

/** GET /api/vendor/gateway-accounts: the shop's merchant accounts, secrets never returned. */
export function fetchGatewayAccounts(): Promise<GatewayAccountListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: GATEWAY_ACCOUNTS_PATH,
    schema: gatewayAccountListResponseSchema,
  });
}

/**
 * PUT /api/vendor/gateway-accounts/:gateway. Checked with the API's own schema first. A changed
 * secret clears the verification: customers are offered the gateway again once a Super Admin
 * verifies it.
 */
export async function saveGatewayAccount(
  gateway: GatewayPaymentMethod,
  draft: GatewayAccountWriteRequest,
): Promise<GatewayAccountResponseBody> {
  const body = gatewayAccountWriteRequestSchema.safeParse(draft);
  if (!body.success) {
    throw new ApiError(400, VENDOR_PAYMENTS_ERROR_CODES.invalid, 'Invalid merchant account');
  }
  return apiRequest({
    method: 'PUT',
    path: `${GATEWAY_ACCOUNTS_PATH}/${gateway}`,
    body: body.data,
    schema: gatewayAccountResponseSchema,
  });
}

/** GET /api/vendor/bank-accounts: the primary account first. */
export function fetchBankAccounts(): Promise<BankAccountListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: BANK_ACCOUNTS_PATH,
    schema: bankAccountListResponseSchema,
  });
}

/** POST /api/vendor/bank-accounts. Checked with the API's own schema first. */
export async function addBankAccount(draft: BankAccountWrite): Promise<BankAccountResponseBody> {
  const body = bankAccountWriteRequestSchema.safeParse(draft);
  if (!body.success) {
    throw new ApiError(400, VENDOR_PAYMENTS_ERROR_CODES.invalid, 'Invalid bank account');
  }
  return apiRequest({
    method: 'POST',
    path: BANK_ACCOUNTS_PATH,
    body: body.data,
    schema: bankAccountResponseSchema,
  });
}

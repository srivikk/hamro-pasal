import { z } from 'zod';

import { MAX_CUSTOMER_WALLET_BALANCE_NPR, MAX_WALLET_RECHARGE_NPR } from '../domain/constants';
import { gatewayPaymentMethodSchema } from '../domain/enums';

/*
 * The customer's stored-value wallet (2026-10-21, SPEC core 12), served under /api/wallet to the
 * signed-in CUSTOMER's own account: no body names a customer. The balance is a projection of the
 * customer's CUSTOMER_WALLET ledger account; only journals move it.
 */

const wholePaisa = (amount: number) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

/**
 * POST /api/wallet/recharge/esewa/initiate (a customer) and POST /api/vendors/wallet/recharge/esewa/initiate
 * (a shop's ledger: a Model C prepaid balance, or dues). One key per attempt: a retry is the
 * same recharge.
 */
export const walletRechargeRequestSchema = z.strictObject({
  idempotency_key: z.string().trim().min(8).max(100),
  amount_npr: z
    .number()
    .positive()
    .max(MAX_WALLET_RECHARGE_NPR)
    .refine(wholePaisa, 'Amounts are in whole paisa'),
});
export type WalletRechargeRequest = z.infer<typeof walletRechargeRequestSchema>;

export const walletRechargeStatuses = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export const walletRechargeStatusSchema = z.enum(walletRechargeStatuses);
export type WalletRechargeStatus = z.infer<typeof walletRechargeStatusSchema>;

export const walletRechargeViewSchema = z.strictObject({
  id: z.uuid(),
  gateway: gatewayPaymentMethodSchema,
  amount_npr: z.number().positive(),
  status: walletRechargeStatusSchema,
  created_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
});
export type WalletRechargeView = z.infer<typeof walletRechargeViewSchema>;

/** 201 (200 for a replayed key): the signed eSewa form, posted by the app's WebView. */
export const walletRechargeInitiateResponseSchema = z.strictObject({
  recharge: walletRechargeViewSchema,
  payment_url: z.url(),
  method: z.literal('POST'),
  fields: z.record(z.string(), z.string()),
});
export type WalletRechargeInitiateResponseBody = z.infer<
  typeof walletRechargeInitiateResponseSchema
>;

/** POST /api/wallet/recharge/esewa/confirm: the `data` eSewa redirected with (HMAC-verified). */
export const walletRechargeConfirmRequestSchema = z.strictObject({ data: z.string().min(1) });
export type WalletRechargeConfirmRequest = z.infer<typeof walletRechargeConfirmRequestSchema>;

export const walletRechargeConfirmResponseSchema = z.strictObject({
  /** eSewa's status: COMPLETE credits the wallet, anything else changes nothing. */
  status: z.string().min(1),
  recharge: walletRechargeViewSchema,
  /** The wallet after it: a customer's (never negative) or a shop's ledger (may still be). */
  balance_npr: z.number(),
  /** false when this confirmation repeated one already credited. */
  credited: z.boolean(),
});
export type WalletRechargeConfirmResponseBody = z.infer<typeof walletRechargeConfirmResponseSchema>;

export const walletEntryKinds = ['RECHARGE', 'PAYMENT', 'REFUND'] as const;
export const walletEntryKindSchema = z.enum(walletEntryKinds);
export type WalletEntryKind = z.infer<typeof walletEntryKindSchema>;

/** GET /api/wallet: the balance and the newest postings (at most 50). */
export const customerWalletViewSchema = z.strictObject({
  balance_npr: z.number().nonnegative(),
  max_balance_npr: z.literal(MAX_CUSTOMER_WALLET_BALANCE_NPR),
  entries: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: walletEntryKindSchema,
      /** Signed: a recharge or refund is positive, a payment negative. */
      amount_npr: z.number(),
      order_id: z.uuid().nullable(),
      created_at: z.iso.datetime(),
    }),
  ),
});
export type CustomerWalletView = z.infer<typeof customerWalletViewSchema>;

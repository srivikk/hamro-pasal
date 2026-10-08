import { z } from 'zod';

/*
 * A vendor's bank accounts (Phase 26, SPEC core 5 "Payouts"): where the platform sends what it
 * holds for the shop. Served under /api/vendor/bank-accounts to the shop's own account.
 */

/** The most accounts one vendor may hold. */
export const MAX_VENDOR_BANK_ACCOUNTS = 5;

export const BANK_ACCOUNT_NUMBER_PATTERN = '^[A-Za-z0-9]{4,34}$';
export const BANK_ROUTING_CODE_PATTERN = '^[A-Za-z0-9]{4,20}$';

const bankText = (max: number) => z.string().trim().min(1).max(max);

/**
 * The body of POST /api/vendor/bank-accounts and PUT /api/vendor/bank-accounts/:id (PUT replaces
 * every field). Strict: no vendor id (the shop is the caller's) and no id.
 *
 * A vendor's first account is its primary one whatever `is_primary` says. Making another account
 * the primary takes it from the previous one in the same transaction; the primary account cannot
 * be un-marked directly.
 */
export const bankAccountWriteRequestSchema = z.strictObject({
  bank_name: bankText(80),
  branch_name: bankText(80),
  /** The account holder's name, as the bank has it. */
  account_name: bankText(120),
  /** Letters and digits only, no spaces. */
  account_number: z.string().regex(new RegExp(BANK_ACCOUNT_NUMBER_PATTERN)),
  /** The bank's routing (NCHL) or SWIFT code, when the transfer needs one. */
  routing_or_swift_code: z.string().regex(new RegExp(BANK_ROUTING_CODE_PATTERN)).nullable(),
  is_primary: z.boolean(),
});
export type BankAccountWrite = z.infer<typeof bankAccountWriteRequestSchema>;

/** One account as its own vendor sees it: the number in full. */
export const bankAccountViewSchema = z.strictObject({
  id: z.uuid(),
  bank_name: z.string().min(1),
  branch_name: z.string().min(1),
  account_name: z.string().min(1),
  account_number: z.string().min(4),
  routing_or_swift_code: z.string().nullable(),
  /** Where the shop's payouts are sent. */
  is_primary: z.boolean(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type BankAccountView = z.infer<typeof bankAccountViewSchema>;

/** GET /api/vendor/bank-accounts: the primary account first, then the oldest first. */
export const bankAccountListResponseSchema = z.strictObject({
  bank_accounts: z.array(bankAccountViewSchema),
});
export type BankAccountListResponseBody = z.infer<typeof bankAccountListResponseSchema>;

/** POST (201) and PUT (200) /api/vendor/bank-accounts. */
export const bankAccountResponseSchema = z.strictObject({ bank_account: bankAccountViewSchema });
export type BankAccountResponseBody = z.infer<typeof bankAccountResponseSchema>;

/** "0123456789012" -> "****9012": how an account number is written to the audit trail. */
export function maskAccountNumber(accountNumber: string): string {
  return `****${accountNumber.slice(-4)}`;
}

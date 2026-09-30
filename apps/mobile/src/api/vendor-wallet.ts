import {
  vendorWalletBalanceResponseSchema,
  vendorWalletLedgerResponseSchema,
  walletTopUpResponseSchema,
  type VendorWalletBalanceResponseBody,
  type VendorWalletLedgerResponseBody,
  type WalletTopUpResponseBody,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

export const VENDOR_WALLET_BALANCE_PATH = '/api/vendors/wallet/balance';
export const VENDOR_WALLET_LEDGER_PATH = '/api/vendors/wallet/ledger';

/** GET /api/vendors/wallet/balance: balance, money still in escrow, suspension state (SPEC §5). */
export function fetchVendorWalletBalance(): Promise<VendorWalletBalanceResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_WALLET_BALANCE_PATH,
    schema: vendorWalletBalanceResponseSchema,
  });
}

/**
 * GET /api/vendors/wallet/ledger: one page of wallet postings, newest first. Pass the previous
 * page's `next_cursor` to get the next one (the server's default page size is used).
 */
export function fetchVendorWalletLedger(
  cursor: string | null = null,
): Promise<VendorWalletLedgerResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_WALLET_LEDGER_PATH,
    ...(cursor === null ? {} : { query: { cursor } }),
    schema: vendorWalletLedgerResponseSchema,
  });
}

export const VENDOR_WALLET_TOP_UP_PATH = '/api/vendors/wallet/top-up';

/** Server code when this server has no top-up flow (WALLET_TOP_UP_MODE=DISABLED). */
export const TOP_UP_UNAVAILABLE = 'TOP_UP_UNAVAILABLE';

/**
 * POST /api/vendors/wallet/top-up (SPEC §5: the vendor clears a negative wallet upfront). Resending
 * the same key never credits twice. The server is in MOCK mode in development (no payment taken).
 */
export function topUpVendorWallet(
  amountNpr: number,
  idempotencyKey: string,
): Promise<WalletTopUpResponseBody> {
  return apiRequest({
    method: 'POST',
    path: VENDOR_WALLET_TOP_UP_PATH,
    body: { idempotency_key: idempotencyKey, amount_npr: amountNpr },
    schema: walletTopUpResponseSchema,
  });
}

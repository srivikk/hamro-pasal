import {
  vendorWalletBalanceResponseSchema,
  vendorWalletLedgerResponseSchema,
  type VendorWalletBalanceResponseBody,
  type VendorWalletLedgerResponseBody,
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

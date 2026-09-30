import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { fetchVendorWalletBalance, fetchVendorWalletLedger } from '../../api/vendor-wallet';
import { retryTransientFailures } from '../../api/query-client';

export const vendorWalletBalanceQueryKey = ['vendor', 'wallet', 'balance'] as const;
export const vendorWalletLedgerQueryKey = ['vendor', 'wallet', 'ledger'] as const;

/** The wallet summary. Always refetched on open: money figures must not be stale. */
export function useVendorWalletBalanceQuery() {
  return useQuery({
    queryKey: vendorWalletBalanceQueryKey,
    queryFn: fetchVendorWalletBalance,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** The wallet's postings, newest first, one server page at a time (cursor pagination). */
export function useVendorWalletLedgerQuery() {
  return useInfiniteQuery({
    queryKey: vendorWalletLedgerQueryKey,
    queryFn: ({ pageParam }) => fetchVendorWalletLedger(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

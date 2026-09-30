import type { VendorWalletBalanceResponseBody } from '@hamro-pasal/shared-types';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../api/http';
import { retryTransientFailures } from '../../api/query-client';
import {
  fetchVendorWalletBalance,
  fetchVendorWalletLedger,
  TOP_UP_UNAVAILABLE,
  topUpVendorWallet,
} from '../../api/vendor-wallet';
import { useToastStore } from '../../store/useToastStore';

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

/**
 * "Pay Outstanding Balance" (SPEC §5, Phase 12.5). One idempotency key per outstanding amount,
 * kept until a payment succeeds: pressing again after a lost response replays the same top-up on
 * the server instead of paying twice. On success the cached balance is patched at once (the banner
 * clears without waiting), then the balance and the ledger are refetched.
 */
export function useVendorTopUp() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const toast = useToastStore((store) => store.show);
  const attempt = useRef<{ amountNpr: number; key: string } | null>(null);

  const mutation = useMutation({
    mutationFn: ({ amountNpr, key }: { amountNpr: number; key: string }) =>
      topUpVendorWallet(amountNpr, key),
    retry: false,
    onSuccess: (result) => {
      attempt.current = null;
      queryClient.setQueryData<VendorWalletBalanceResponseBody>(
        vendorWalletBalanceQueryKey,
        (old) =>
          old === undefined
            ? old
            : {
                ...old,
                status: result.status,
                is_suspended: result.is_suspended,
                suspended_for_debt: result.is_suspended && old.suspended_for_debt,
                wallet_balance_npr: result.wallet_balance_npr,
              },
      );
      toast(t(result.is_suspended ? 'vendorWallet.paidPartly' : 'vendorWallet.paid'), 'success');
    },
    onError: (error) => {
      const unavailable = error instanceof ApiError && error.code === TOP_UP_UNAVAILABLE;
      toast(t(unavailable ? 'vendorWallet.payUnavailable' : 'vendorWallet.payFailed'), 'error');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: vendorWalletBalanceQueryKey });
      void queryClient.invalidateQueries({ queryKey: vendorWalletLedgerQueryKey });
    },
  });

  const payOutstanding = (amountNpr: number): void => {
    if (attempt.current?.amountNpr !== amountNpr) {
      attempt.current = { amountNpr, key: randomUUID() };
    }
    mutation.mutate(attempt.current);
  };

  return { payOutstanding, paying: mutation.isPending };
}

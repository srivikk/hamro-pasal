import type {
  BankAccountWrite,
  BillingChangeRequest,
  GatewayAccountWriteRequest,
  GatewayPaymentMethod,
} from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import {
  addBankAccount,
  fetchBankAccounts,
  fetchGatewayAccounts,
  fetchVendorBilling,
  requestBillingChange,
  saveGatewayAccount,
  withdrawBillingChange,
} from '../../api/vendor-payments';

export const VENDOR_BILLING_QUERY_KEY = ['vendor', 'billing'] as const;
export const GATEWAY_ACCOUNTS_QUERY_KEY = ['vendor', 'gateway-accounts'] as const;
export const BANK_ACCOUNTS_QUERY_KEY = ['vendor', 'bank-accounts'] as const;

/** The shop's plan, payment methods, queued changes, dues and reserve, as the server holds them. */
export function useVendorBillingQuery() {
  return useQuery({
    queryKey: VENDOR_BILLING_QUERY_KEY,
    queryFn: fetchVendorBilling,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** Model C merchant accounts; only asked for when the shop takes direct payments. */
export function useGatewayAccountsQuery(enabled: boolean) {
  return useQuery({
    queryKey: GATEWAY_ACCOUNTS_QUERY_KEY,
    queryFn: fetchGatewayAccounts,
    enabled,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

export function useBankAccountsQuery() {
  return useQuery({
    queryKey: BANK_ACCOUNTS_QUERY_KEY,
    queryFn: fetchBankAccounts,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** Writes are never retried automatically; each refetches what it changed. */
export function useRequestBillingChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: BillingChangeRequest) => requestBillingChange(change),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: VENDOR_BILLING_QUERY_KEY }),
  });
}

export function useWithdrawBillingChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => withdrawBillingChange(id),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: VENDOR_BILLING_QUERY_KEY }),
  });
}

export function useSaveGatewayAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      gateway,
      draft,
    }: {
      gateway: GatewayPaymentMethod;
      draft: GatewayAccountWriteRequest;
    }) => saveGatewayAccount(gateway, draft),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: GATEWAY_ACCOUNTS_QUERY_KEY }),
  });
}

export function useAddBankAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: BankAccountWrite) => addBankAccount(draft),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: BANK_ACCOUNTS_QUERY_KEY }),
  });
}

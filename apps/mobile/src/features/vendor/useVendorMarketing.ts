import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import {
  cancelVendorAdPurchase,
  fetchVendorAdProducts,
  fetchVendorAdPurchases,
  purchaseVendorAd,
} from '../../api/vendor-ads';
import {
  fetchVendorCampaigns,
  optInToCampaign,
  optOutOfCampaign,
} from '../../api/vendor-campaigns';
import { fetchVendorInvoices } from '../../api/vendor-invoices';
import { createVendorOffer, endVendorOffer, fetchVendorOffers } from '../../api/vendor-offers';
import { downloadInvoicePdf } from './invoice-files';
import { vendorWalletBalanceQueryKey, vendorWalletLedgerQueryKey } from './useVendorWallet';

export const vendorAdProductsQueryKey = ['vendor', 'ads', 'products'] as const;
export const vendorAdPurchasesQueryKey = ['vendor', 'ads', 'purchases'] as const;
export const vendorCampaignsQueryKey = ['vendor', 'campaigns'] as const;
export const vendorOffersQueryKey = ['vendor', 'offers'] as const;
export const vendorInvoicesQueryKey = ['vendor', 'invoices'] as const;

/** The shop's own offers with the server's status for each (GET /api/vendor/offers). */
export function useVendorOffersQuery() {
  return useQuery({
    queryKey: vendorOffersQueryKey,
    queryFn: fetchVendorOffers,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** Both refetch the list whatever the answer: the cards always show the server's offers. */
export function useCreateVendorOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createVendorOffer,
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: vendorOffersQueryKey }),
  });
}

export function useEndVendorOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: endVendorOffer,
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: vendorOffersQueryKey }),
  });
}

/** The shop's fiscal invoices, newest first, a page at a time (GET /api/vendor/invoices). */
export function useVendorInvoicesQuery() {
  return useInfiniteQuery({
    queryKey: vendorInvoicesQueryKey,
    queryFn: ({ pageParam }) => fetchVendorInvoices(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/**
 * One download = one numbered print on the server, so it is never retried automatically. The list
 * is refetched afterwards (also after a failure: the print may have been recorded) for its count.
 */
export function useDownloadInvoicePdf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, invoiceSequence }: { id: string; invoiceSequence: string }) =>
      downloadInvoicePdf(id, invoiceSequence),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: vendorInvoicesQueryKey }),
  });
}

/** What is on sale and what the shop can spend. Money figures are never served stale. */
export function useVendorAdProductsQuery() {
  return useQuery({
    queryKey: vendorAdProductsQueryKey,
    queryFn: fetchVendorAdProducts,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

export function useVendorAdPurchasesQuery() {
  return useQuery({
    queryKey: vendorAdPurchasesQueryKey,
    queryFn: fetchVendorAdPurchases,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** After any ad write, refused or not: funds, purchases and the wallet may all have moved. */
function useRefreshAds(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all(
      [
        vendorAdProductsQueryKey,
        vendorAdPurchasesQueryKey,
        vendorWalletBalanceQueryKey,
        vendorWalletLedgerQueryKey,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  };
}

/** Never retried automatically: the caller resends with the same idempotency key. */
export function usePurchaseVendorAd() {
  const refresh = useRefreshAds();
  return useMutation({ mutationFn: purchaseVendorAd, retry: false, onSettled: refresh });
}

export function useCancelVendorAdPurchase() {
  const refresh = useRefreshAds();
  return useMutation({ mutationFn: cancelVendorAdPurchase, retry: false, onSettled: refresh });
}

export function useVendorCampaignsQuery() {
  return useQuery({
    queryKey: vendorCampaignsQueryKey,
    queryFn: fetchVendorCampaigns,
    staleTime: 0,
    retry: retryTransientFailures,
  });
}

/** Both refetch the list whatever the answer, so the cards show the server's terms and status. */
export function useCampaignOptIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ campaignId, termsVersion }: { campaignId: string; termsVersion: number }) =>
      optInToCampaign(campaignId, termsVersion),
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: vendorCampaignsQueryKey }),
  });
}

export function useCampaignOptOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: optOutOfCampaign,
    retry: false,
    onSettled: () => queryClient.invalidateQueries({ queryKey: vendorCampaignsQueryKey }),
  });
}

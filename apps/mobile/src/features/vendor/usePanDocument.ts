import type { TaxIdentityView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import {
  fetchTaxIdentity,
  saveTaxIdentity,
  uploadPanDocument,
  type PanDocumentFile,
  type TaxIdentityDraft,
} from '../../api/vendor-tax-identity';

export const TAX_IDENTITY_QUERY_KEY = ['vendor', 'tax-identity'] as const;

/**
 * The shop's tax identity as the server holds it (whether a PAN document is on file, verified).
 * It drives the dashboard's "pending verification" banner, and the verification happens on the
 * Super Admin's side: so it is read again every time the app returns to the foreground
 * (`refetchOnWindowFocus: 'always'`, see app-focus.ts), and an approval shows without a relaunch.
 */
export function useTaxIdentityQuery() {
  return useQuery({
    queryKey: TAX_IDENTITY_QUERY_KEY,
    queryFn: fetchTaxIdentity,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    retry: retryTransientFailures,
  });
}

/**
 * Saves the PAN number and the VAT registration (PUT /api/vendor/tax-identity). Never retried
 * automatically. The answer is written into the cached tax identity at once, so the document
 * card beside it shows "no document" the moment a changed number removed the old one; then the
 * query is refetched.
 */
export function useSaveTaxIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: TaxIdentityDraft) => saveTaxIdentity(draft),
    retry: false,
    onSuccess: (result) => {
      queryClient.setQueryData<TaxIdentityView>(TAX_IDENTITY_QUERY_KEY, {
        vendor_id: result.vendor_id,
        tax_id: result.tax_id,
        is_vat_registered: result.is_vat_registered,
        legal_name: result.legal_name,
        registered_address: result.registered_address,
        status: result.status,
        pan_verified_at: result.pan_verified_at,
        has_pan_document: result.has_pan_document,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TAX_IDENTITY_QUERY_KEY }),
  });
}

/**
 * Uploads the PAN document. Never retried automatically: a retry is a second upload. The answer
 * is written into the cached tax identity at once, then the query is refetched.
 */
export function useUploadPanDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: PanDocumentFile) => uploadPanDocument(file),
    retry: false,
    onSuccess: (result) => {
      queryClient.setQueryData<TaxIdentityView>(TAX_IDENTITY_QUERY_KEY, (current) =>
        current === undefined
          ? current
          : { ...current, has_pan_document: true, pan_verified_at: result.pan_verified_at },
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: TAX_IDENTITY_QUERY_KEY }),
  });
}

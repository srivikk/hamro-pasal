import type { TaxIdentityView } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { retryTransientFailures } from '../../api/query-client';
import {
  fetchTaxIdentity,
  uploadPanDocument,
  type PanDocumentFile,
} from '../../api/vendor-tax-identity';

export const TAX_IDENTITY_QUERY_KEY = ['vendor', 'tax-identity'] as const;

/** The shop's tax identity as the server holds it (whether a PAN document is on file, verified). */
export function useTaxIdentityQuery() {
  return useQuery({
    queryKey: TAX_IDENTITY_QUERY_KEY,
    queryFn: fetchTaxIdentity,
    staleTime: 0,
    retry: retryTransientFailures,
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

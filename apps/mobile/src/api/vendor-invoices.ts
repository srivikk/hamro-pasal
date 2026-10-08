import {
  vendorInvoiceListResponseSchema,
  type VendorInvoiceListResponseBody,
} from '@hamro-pasal/shared-types';

import { ApiError, apiDownload, apiRequest, CLIENT_ERROR_CODES } from './http';

export const VENDOR_INVOICES_PATH = '/api/vendor/invoices';
export const INVOICE_COPY_NUMBER_HEADER = 'X-Invoice-Copy-Number';

export const INVOICE_ERROR_CODES = {
  notFound: 'INVOICE_NOT_FOUND',
  /** The server cannot render invoices at the moment (503). */
  printUnavailable: 'INVOICE_PRINT_UNAVAILABLE',
} as const;

/** GET /api/vendor/invoices: the shop's invoices, newest first, paged by the last invoice's id. */
export function fetchVendorInvoices(cursor: string | null): Promise<VendorInvoiceListResponseBody> {
  return apiRequest({
    method: 'GET',
    path: VENDOR_INVOICES_PATH,
    ...(cursor === null ? {} : { query: { cursor } }),
    schema: vendorInvoiceListResponseSchema,
  });
}

export interface PrintedInvoicePdf {
  readonly bytes: Uint8Array;
  /** 0: this is the ORIGINAL. n: COPY OF ORIGINAL (n), as marked on the page. */
  readonly copyNumber: number;
}

/**
 * GET /api/vendor/invoices/:id/pdf: the invoice as the server renders it.
 *
 * **Every successful call is one numbered print** (SPEC core 10): the first is the original, each
 * later one a copy, and the server logs it. Call it only on the vendor's explicit request, and
 * never retry it automatically.
 */
export async function printVendorInvoicePdf(invoiceId: string): Promise<PrintedInvoicePdf> {
  const path = `${VENDOR_INVOICES_PATH}/${invoiceId}/pdf`;
  const { bytes, headers } = await apiDownload(path, 'application/pdf');
  const copyNumber = Number(headers.get(INVOICE_COPY_NUMBER_HEADER));
  // "%PDF": anything else is not the document the vendor asked for.
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (!isPdf || !Number.isInteger(copyNumber) || copyNumber < 0) {
    throw new ApiError(200, CLIENT_ERROR_CODES.badResponse, `GET ${path} did not answer a PDF`);
  }
  return { bytes, copyNumber };
}

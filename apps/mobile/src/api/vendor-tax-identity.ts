import {
  PAN_DOCUMENT_FILE_FIELD,
  panDocumentUploadResponseSchema,
  taxIdentityRequestSchema,
  taxIdentityResponseSchema,
  taxIdentityViewSchema,
  type PanDocumentUploadResponseBody,
  type TaxIdentityResponseBody,
  type TaxIdentityView,
} from '@hamro-pasal/shared-types';

import { localFilePart } from './file-part';
import { ApiError, apiRequest } from './http';

export const TAX_IDENTITY_PATH = '/api/vendor/tax-identity';
export const PAN_DOCUMENT_PATH = '/api/vendor/tax-identity/document';

/** A photo of the PAN document, already compressed on the device (`preparePanDocument`). */
export interface PanDocumentFile {
  readonly uri: string;
  readonly mimeType: 'image/jpeg';
}

/** What the shop has on file: its PAN, whether it is verified, whether a document was uploaded. */
export function fetchTaxIdentity(): Promise<TaxIdentityView> {
  return apiRequest({ method: 'GET', path: TAX_IDENTITY_PATH, schema: taxIdentityViewSchema });
}

/** What the Tax identity section sends: the PAN number and whether the shop is VAT registered. */
export interface TaxIdentityDraft {
  readonly taxId: string;
  readonly isVatRegistered: boolean;
}

/** Codes the Tax identity section words itself. */
export const TAX_IDENTITY_ERROR_CODES = {
  /** Client side: not nine digits, so nothing was sent. */
  invalid: 'INVALID_TAX_IDENTITY',
} as const;

/**
 * PUT /api/vendor/tax-identity. Saving the PAN lifts a compliance suspension; saving a different
 * number clears the verification and removes the document of the old one. The legal name and the
 * registered address are not sent, so the server keeps what it has. Checked with the API's own
 * schema first: a number that breaks it is not sent.
 */
export async function saveTaxIdentity(draft: TaxIdentityDraft): Promise<TaxIdentityResponseBody> {
  const body = taxIdentityRequestSchema.safeParse({
    tax_id: draft.taxId,
    is_vat_registered: draft.isVatRegistered,
  });
  if (!body.success) {
    throw new ApiError(400, TAX_IDENTITY_ERROR_CODES.invalid, 'A PAN is nine digits');
  }
  return apiRequest({
    method: 'PUT',
    path: TAX_IDENTITY_PATH,
    body: body.data,
    schema: taxIdentityResponseSchema,
  });
}

/**
 * POST /api/vendor/tax-identity/document (multipart, one `document` part, see `localFilePart`).
 * The server stores it privately and replaces an earlier document.
 */
export function uploadPanDocument(file: PanDocumentFile): Promise<PanDocumentUploadResponseBody> {
  const form = new FormData();
  form.append(PAN_DOCUMENT_FILE_FIELD, localFilePart(file.uri));
  return apiRequest({
    method: 'POST',
    path: PAN_DOCUMENT_PATH,
    body: form,
    schema: panDocumentUploadResponseSchema,
  });
}

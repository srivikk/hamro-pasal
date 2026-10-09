import {
  PAN_DOCUMENT_FILE_FIELD,
  panDocumentUploadResponseSchema,
  taxIdentityViewSchema,
  type PanDocumentUploadResponseBody,
  type TaxIdentityView,
} from '@hamro-pasal/shared-types';

import { apiRequest } from './http';

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

/**
 * POST /api/vendor/tax-identity/document (multipart, one `document` part). React Native's FormData
 * sends a `{ uri, name, type }` part by streaming the file at `uri`; the DOM typings only know
 * Blob, hence the cast. The server stores it privately and replaces an earlier document.
 */
export function uploadPanDocument(file: PanDocumentFile): Promise<PanDocumentUploadResponseBody> {
  const form = new FormData();
  form.append(PAN_DOCUMENT_FILE_FIELD, {
    uri: file.uri,
    name: 'pan-document.jpg',
    type: file.mimeType,
  } as unknown as Blob);
  return apiRequest({
    method: 'POST',
    path: PAN_DOCUMENT_PATH,
    body: form,
    schema: panDocumentUploadResponseSchema,
  });
}

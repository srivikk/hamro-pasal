import {
  PAN_DOCUMENT_FILE_FIELD,
  roleNotGrantedDetailsSchema,
  sellerApplicationResponseSchema,
  sellerSignupResponseSchema,
  type SellerApplicationView,
  type SellerSignupRequest,
  type SellerSignupResponseBody,
} from '@hamro-pasal/shared-types';

import { ApiError, apiRequest } from '../../api/http';

export const SELLER_SIGNUP_PATH = '/api/seller/signup';
export const SELLER_APPLICATION_PATH = '/api/seller/application';

/** POST /api/seller/signup (step 7.7): the shop, SANDBOXED, and a vendor session. */
export function signUpSeller(body: SellerSignupRequest): Promise<SellerSignupResponseBody> {
  return apiRequest({
    method: 'POST',
    path: SELLER_SIGNUP_PATH,
    body,
    schema: sellerSignupResponseSchema,
    authenticated: false,
  });
}

/** GET /api/seller/application: what the shop still needs before Hamro Pasal reviews it. */
export async function fetchSellerApplication(): Promise<SellerApplicationView> {
  const body = await apiRequest({
    method: 'GET',
    path: SELLER_APPLICATION_PATH,
    schema: sellerApplicationResponseSchema,
  });
  return body.application;
}

/**
 * The signup token of a 403 ROLE_NOT_GRANTED (the Seller app signed in a number with no shop),
 * or null for any other error.
 */
export function signupTokenOf(
  error: unknown,
): { readonly token: string; readonly expiresInSeconds: number } | null {
  if (!(error instanceof ApiError) || error.code !== 'ROLE_NOT_GRANTED') return null;
  const details = roleNotGrantedDetailsSchema.safeParse(error.details);
  return details.success
    ? { token: details.data.signup_token, expiresInSeconds: details.data.signup_token_expires_in }
    : null;
}

export const CITIZENSHIP_DOCUMENT_PATH = '/api/vendor/kyc/citizenship-document';

/** A photo picked on the phone, as React Native's FormData streams it. */
export interface KycDocumentFile {
  readonly uri: string;
  readonly mimeType: string;
}

/** POST /api/vendor/kyc/citizenship-document (multipart, one `document` part). */
export async function uploadCitizenshipDocument(
  file: KycDocumentFile,
): Promise<SellerApplicationView> {
  const form = new FormData();
  form.append(PAN_DOCUMENT_FILE_FIELD, {
    uri: file.uri,
    name: 'citizenship-document.jpg',
    type: file.mimeType,
  } as unknown as Blob);
  const body = await apiRequest({
    method: 'POST',
    path: CITIZENSHIP_DOCUMENT_PATH,
    body: form,
    schema: sellerApplicationResponseSchema,
  });
  return body.application;
}

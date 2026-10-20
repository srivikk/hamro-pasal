import {
  PAN_DOCUMENT_FILE_FIELD,
  roleNotGrantedDetailsSchema,
  sellerApplicationResponseSchema,
  sellerSignupOptionsResponseSchema,
  sellerSignupResponseSchema,
  type SellerApplicationView,
  type SellerSignupOptionsResponseBody,
  type SellerSignupRequest,
  type SellerSignupResponseBody,
} from '@hamro-pasal/shared-types';

import { localFilePart } from '../../api/file-part';
import { ApiError, apiRequest } from '../../api/http';

export const SELLER_SIGNUP_PATH = '/api/seller/signup';
export const SELLER_APPLICATION_PATH = '/api/seller/application';
export const SELLER_SIGNUP_OPTIONS_PATH = '/api/seller/signup-options';

/**
 * GET /api/seller/signup-options (public, 2026-10-20): the delivery modes a new shop may choose,
 * as the Super Admin's platform switches stand now.
 */
export function fetchSellerSignupOptions(): Promise<SellerSignupOptionsResponseBody> {
  return apiRequest({
    method: 'GET',
    path: SELLER_SIGNUP_OPTIONS_PATH,
    schema: sellerSignupOptionsResponseSchema,
    authenticated: false,
  });
}

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

/** POST /api/vendor/kyc/citizenship-document (multipart, one `document` part, see `localFilePart`). */
export async function uploadCitizenshipDocument(
  file: KycDocumentFile,
): Promise<SellerApplicationView> {
  const form = new FormData();
  form.append(PAN_DOCUMENT_FILE_FIELD, localFilePart(file.uri));
  const body = await apiRequest({
    method: 'POST',
    path: CITIZENSHIP_DOCUMENT_PATH,
    body: form,
    schema: sellerApplicationResponseSchema,
  });
  return body.application;
}

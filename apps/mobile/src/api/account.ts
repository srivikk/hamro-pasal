import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';

import { APP_LOCALES, type AppLocale } from '../i18n/app-locale';
import { ApiError, apiRequest } from './http';

/**
 * The signed-in account's own record. PROPOSED, not built on the API yet (STATE_HANDOFF §8Z.10):
 * in a development build these paths are answered by the MSW handlers of src/mocks when
 * EXPO_PUBLIC_MOCK_ACCOUNT_API is "true"; in tests by the same handlers.
 */
export const ME_PATH = '/api/me';
export const DELETION_ELIGIBILITY_PATH = '/api/user/deletion-eligibility';
export const DELETION_REQUEST_PATH = '/api/user/deletion-request';

export const ACCOUNT_STATUSES = ['ACTIVE', 'DELETED_REQUESTED', 'SUSPENDED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** The parts of `user` this app reads; other keys the server sends are ignored. */
const accountUserSchema = z.object({
  full_name: z.string().nullable(),
  email: z.string().nullable(),
  language_preference: z.enum(APP_LOCALES),
  terms_accepted_at: z.iso.datetime({ offset: true }).nullable(),
  whatsapp_opt_in: z.boolean(),
  account_status: z.enum(ACCOUNT_STATUSES),
});
export type AccountUser = z.infer<typeof accountUserSchema>;

export const accountResponseSchema = z.object({ user: accountUserSchema });

/**
 * What PATCH /api/me accepts; every key is optional and only the keys sent are changed.
 * `accept_terms: true` asks the server to stamp `terms_accepted_at` with its own clock: the
 * device never sends a timestamp for a consent.
 */
export interface AccountPatch {
  full_name?: string;
  email?: string | null;
  language_preference?: AppLocale;
  whatsapp_opt_in?: boolean;
  accept_terms?: true;
}

/** The server has no such route yet (the proposed endpoints answer the catch-all 404). */
export function isEndpointMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * PATCH /api/me. Resolves the account as the server now holds it, or null when the server does
 * not have the route yet: the caller then keeps the change on this phone only. Every other
 * failure (no connection, a refused value, no session) rejects with ApiError.
 */
export async function updateAccount(patch: AccountPatch): Promise<AccountUser | null> {
  try {
    const { user } = await apiRequest({
      method: 'PATCH',
      path: ME_PATH,
      body: patch,
      schema: accountResponseSchema,
    });
    return user;
  } catch (error) {
    if (isEndpointMissing(error)) return null;
    throw error;
  }
}

/**
 * Copies the language chosen on this phone to the signed-in account (`users.language_preference`),
 * so server-written texts (SMS, push) can use it. Best effort: never throws and never blocks.
 */
export async function syncLanguagePreference(locale: AppLocale): Promise<void> {
  try {
    await updateAccount({ language_preference: locale });
  } catch {
    // The preference stays on the phone and is sent again at the next sign-in or change.
  }
}

export function useUpdateAccount() {
  return useMutation<AccountUser | null, ApiError, AccountPatch>({
    mutationKey: ['account', 'update'],
    mutationFn: updateAccount,
  });
}

const deletionEligibilitySchema = z.object({
  eligible: z.boolean(),
  /** Orders that are not DELIVERED, CANCELED or FAILED. */
  pending_order_count: z.number().int().min(0),
});
export type DeletionEligibility = z.infer<typeof deletionEligibilitySchema>;

/** GET /api/user/deletion-eligibility: may this account ask to be deleted now? */
export function fetchDeletionEligibility(): Promise<DeletionEligibility> {
  return apiRequest({
    method: 'GET',
    path: DELETION_ELIGIBILITY_PATH,
    schema: deletionEligibilitySchema,
  });
}

const deletionRequestSchema = z.object({
  account_status: z.literal('DELETED_REQUESTED'),
  deletion_requested_at: z.iso.datetime({ offset: true }),
});
export type DeletionRequest = z.infer<typeof deletionRequestSchema>;

/** The server's refusal when an order is still open (it checks again, whatever the app asked). */
export const ACCOUNT_HAS_PENDING_ORDERS = 'ACCOUNT_HAS_PENDING_ORDERS';

/** POST /api/user/deletion-request: the soft delete (`account_status = 'DELETED_REQUESTED'`). */
export function requestAccountDeletion(): Promise<DeletionRequest> {
  return apiRequest({
    method: 'POST',
    path: DELETION_REQUEST_PATH,
    schema: deletionRequestSchema,
  });
}

export function useDeletionEligibility() {
  return useMutation<DeletionEligibility, ApiError>({
    mutationKey: ['account', 'deletion-eligibility'],
    mutationFn: fetchDeletionEligibility,
  });
}

export function useRequestAccountDeletion() {
  return useMutation<DeletionRequest, ApiError>({
    mutationKey: ['account', 'deletion-request'],
    mutationFn: requestAccountDeletion,
  });
}

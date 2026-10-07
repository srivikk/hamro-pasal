import { http, HttpResponse, type HttpHandler } from 'msw';

import {
  ACCOUNT_HAS_PENDING_ORDERS,
  DELETION_ELIGIBILITY_PATH,
  DELETION_REQUEST_PATH,
  ME_PATH,
  type AccountUser,
} from '../api/account';
import { isAppLocale } from '../i18n/app-locale';

export interface AccountMockOptions {
  /** The API origin the app calls, e.g. `http://192.168.1.20:4000`. */
  baseUrl: string;
  /** How many of the account's orders are still open; decides deletion eligibility. */
  pendingOrderCount?: () => number;
  now?: () => Date;
}

function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/**
 * MOCK ONLY: stands in for the account endpoints the API does not have yet (PATCH /api/me,
 * GET /api/user/deletion-eligibility, POST /api/user/deletion-request; contract in STATE_HANDOFF
 * §8Z.10). One account, held in memory for the life of the handlers. Used by the Jest server and,
 * in a development build, by src/mocks/dev-mocks.ts. Delete with the mocks once the API serves
 * these routes.
 */
export function accountMockHandlers({
  baseUrl,
  pendingOrderCount = () => 0,
  now = () => new Date(),
}: AccountMockOptions): HttpHandler[] {
  const user: AccountUser = {
    full_name: null,
    email: null,
    language_preference: 'en',
    terms_accepted_at: null,
    whatsapp_opt_in: false,
    account_status: 'ACTIVE',
  };
  const url = (path: string): string => `${baseUrl}${path}`;
  const invalid = (field: string) =>
    HttpResponse.json(errorBody('VALIDATION_FAILED', `Invalid ${field}`), { status: 400 });

  return [
    http.get(url(ME_PATH), () => HttpResponse.json({ user })),

    http.patch(url(ME_PATH), async ({ request }) => {
      const body: unknown = await request.json();
      if (typeof body !== 'object' || body === null) return invalid('body');
      const patch = body as Record<string, unknown>;

      if ('full_name' in patch) {
        const name = typeof patch.full_name === 'string' ? patch.full_name.trim() : '';
        if (name.length < 2 || name.length > 80) return invalid('full_name');
        user.full_name = name;
      }
      if ('email' in patch) {
        if (patch.email !== null && typeof patch.email !== 'string') return invalid('email');
        user.email = patch.email === null ? null : patch.email.toLowerCase();
      }
      if ('language_preference' in patch) {
        if (!isAppLocale(patch.language_preference)) return invalid('language_preference');
        user.language_preference = patch.language_preference;
      }
      if ('whatsapp_opt_in' in patch) {
        if (typeof patch.whatsapp_opt_in !== 'boolean') return invalid('whatsapp_opt_in');
        user.whatsapp_opt_in = patch.whatsapp_opt_in;
      }
      if ('accept_terms' in patch) {
        if (patch.accept_terms !== true) return invalid('accept_terms');
        // Stamped once: accepting again never moves the original time.
        user.terms_accepted_at ??= now().toISOString();
      }
      return HttpResponse.json({ user });
    }),

    http.get(url(DELETION_ELIGIBILITY_PATH), () => {
      const pending = pendingOrderCount();
      return HttpResponse.json({ eligible: pending === 0, pending_order_count: pending });
    }),

    http.post(url(DELETION_REQUEST_PATH), () => {
      const pending = pendingOrderCount();
      if (pending > 0) {
        return HttpResponse.json(
          errorBody(ACCOUNT_HAS_PENDING_ORDERS, 'Complete or cancel your open orders first', {
            pending_order_count: pending,
          }),
          { status: 409 },
        );
      }
      user.account_status = 'DELETED_REQUESTED';
      return HttpResponse.json({
        account_status: user.account_status,
        deletion_requested_at: now().toISOString(),
      });
    }),
  ];
}

import { errorBodySchema, sessionRefreshResponseSchema } from '@hamro-pasal/shared-types';
import type { z } from 'zod';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionState } from '../auth/session-store';

/** A failed call: the server's `{ error: { code, message, details } }`, or a client-side code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Client-side codes (no server answer to report). */
export const CLIENT_ERROR_CODES = {
  NOT_SIGNED_IN: 'NOT_SIGNED_IN',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNEXPECTED_RESPONSE: 'UNEXPECTED_RESPONSE',
} as const;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiRequest<TSchema extends z.ZodType> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly schema: TSchema;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface ApiClient {
  /** A call with the admin's access token, renewed once on a 401 UNAUTHENTICATED. */
  request<TSchema extends z.ZodType>(request: ApiRequest<TSchema>): Promise<z.output<TSchema>>;
  /** A call without a token (the OTP sign-in endpoints). */
  publicRequest<TSchema extends z.ZodType>(
    request: ApiRequest<TSchema>,
  ): Promise<z.output<TSchema>>;
  /**
   * The silent refresh on page load: true when the browser still holds a valid refresh cookie (the
   * session is then in the store), false when it does not. Rejects when the API cannot be reached.
   */
  restoreSession(): Promise<boolean>;
}

/** The body as JSON, or null when it is empty or not JSON (then the contract check reports it). */
function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function buildUrl(baseUrl: string, path: string, query: ApiRequest<z.ZodType>['query']): string {
  const params = Object.entries(query ?? {}).flatMap(([name, value]) =>
    value === undefined ? [] : [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`],
  );
  return `${baseUrl}${path}${params.length === 0 ? '' : `?${params.join('&')}`}`;
}

/**
 * The dashboard's HTTP layer. Every 2xx body is validated with its shared-types schema (a contract
 * break surfaces as UNEXPECTED_RESPONSE, never as bad data on screen) and every error body is
 * parsed into an ApiError. Token renewal mirrors the mobile app (STATE_HANDOFF §9.3): one refresh
 * for a burst of 401s, one replay, and only a refused refresh (400/401) ends the session. Unlike
 * the mobile app, the refresh token is an HttpOnly cookie the browser attaches by itself (§8J).
 */
export function createApiClient(options: {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  readonly session: StoreApi<SessionState>;
}): ApiClient {
  const { baseUrl, session } = options;
  let refreshInFlight: Promise<string | null> | null = null;

  async function send<TSchema extends z.ZodType>(
    request: ApiRequest<TSchema>,
    accessToken: string | null,
  ): Promise<z.output<TSchema>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (accessToken !== null) headers.authorization = `Bearer ${accessToken}`;
    if (request.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await options.fetch(buildUrl(baseUrl, request.path, request.query), {
        method: request.method,
        headers,
        // The refresh cookie must reach /api/auth (and be stored from it); never another origin.
        credentials: 'same-origin',
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error: unknown) {
      throw new ApiError(
        0,
        CLIENT_ERROR_CODES.NETWORK_ERROR,
        error instanceof Error ? error.message : 'Network request failed',
      );
    }
    const json = parseJson(await response.text());
    if (!response.ok) {
      const parsed = errorBodySchema.safeParse(json);
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new ApiError(response.status, code, message, details);
      }
      throw new ApiError(
        response.status,
        CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE,
        `HTTP ${String(response.status)}`,
      );
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        CLIENT_ERROR_CODES.UNEXPECTED_RESPONSE,
        `Response of ${request.path} did not match its contract`,
      );
    }
    return parsed.data;
  }

  /**
   * Trades the HttpOnly refresh cookie (sent by the browser, never visible here) for a new access
   * token. The answer names the account, so the same call restores a session after a page reload.
   */
  async function runRefresh(): Promise<string | null> {
    // Whose session this refresh started for (null: none yet, the page was just loaded).
    const signedInAs = () => session.getState().session?.user.id ?? null;
    const startedAs = signedInAs();
    try {
      const body = await send(
        { method: 'POST', path: '/api/auth/refresh', schema: sessionRefreshResponseSchema },
        null,
      );
      // Signed out (or someone else signed in) meanwhile: never revive that session.
      if (signedInAs() !== startedAs) return null;
      const { phone, ...user } = body.user;
      session.getState().setSession({ phone, user, accessToken: body.access_token });
      return body.access_token;
    } catch (error: unknown) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 401)) {
        if (signedInAs() === startedAs) session.getState().clear();
        return null;
      }
      throw error; // network or 5xx: keep the session
    }
  }

  function refreshAccessToken(): Promise<string | null> {
    refreshInFlight ??= runRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  return {
    publicRequest: (request) => send(request, null),

    restoreSession: async () => (await refreshAccessToken()) !== null,

    async request(request) {
      const token = session.getState().session?.accessToken ?? null;
      if (token === null) {
        throw new ApiError(401, CLIENT_ERROR_CODES.NOT_SIGNED_IN, 'Sign in first');
      }
      try {
        return await send(request, token);
      } catch (error: unknown) {
        // Only an expired/invalid token is renewed; any other 401 is the answer itself.
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        if (error.code !== 'UNAUTHENTICATED') throw error;
        const current = session.getState().session?.accessToken ?? null;
        const renewed =
          current !== null && current !== token ? current : await refreshAccessToken();
        if (renewed === null) throw error;
        return send(request, renewed);
      }
    },
  };
}

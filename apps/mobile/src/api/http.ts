import { errorBodySchema, tokenRefreshResponseSchema } from '@hamro-pasal/shared-types';
import type { z } from 'zod';

import { API_URL } from '../config/api';
import { useAuthStore } from '../store/useAuthStore';

/**
 * A failed API call. `code` is the server's stable error code (STATE_HANDOFF §8 error table) or one
 * of the client-side codes below; UI branches on `code`, never on `message`.
 */
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

/** Client-side codes for failures that never produced a server error body. */
/** The API's 401 code for a missing, invalid or expired access token (`requireAuth`). */
const TOKEN_REFUSED_CODE = 'UNAUTHENTICATED';

export const CLIENT_ERROR_CODES = {
  /** No access token in memory: the request was not sent. */
  notSignedIn: 'NOT_SIGNED_IN',
  /** fetch() itself failed (offline, DNS, TLS, connection reset). */
  network: 'NETWORK_ERROR',
  /** The server answered, but not with the documented contract. */
  badResponse: 'UNEXPECTED_RESPONSE',
} as const;

interface ApiRequest<T> {
  method: 'GET' | 'POST' | 'PATCH';
  /** Path under the API base URL, starting with `/`. */
  path: string;
  query?: Record<string, string>;
  /** JSON-encoded, except FormData, which is sent as multipart/form-data. */
  body?: unknown;
  /**
   * Defaults to true: send `Authorization: Bearer` and refuse to call without a token. Only the
   * sign-in endpoints (which is how a token is obtained) pass false.
   */
  authenticated?: boolean;
  /** Response body contract; the body is validated before it reaches the caller. */
  schema: z.ZodType<T>;
}

/** A binary response body with the headers it came with. */
export interface ApiDownload {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One HTTP exchange: builds the URL by hand (React Native's URLSearchParams polyfill is
 * incomplete), attaches the given access token, maps error bodies to ApiError and validates 2xx
 * bodies with the shared-types schema.
 */
async function send<T>(
  { method, path, query, body, schema }: ApiRequest<T>,
  token: string | null,
): Promise<T> {
  const search =
    query === undefined
      ? ''
      : `?${Object.entries(query)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&')}`;
  const url = `${API_URL}${path}${search}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
  };
  // fetch sets the multipart Content-Type (with its boundary) itself for FormData.
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new ApiError(0, CLIENT_ERROR_CODES.network, `${method} ${path} failed: ${String(cause)}`);
  }

  const json = await readJson(response);

  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(json);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.badResponse,
      `${method} ${path} returned HTTP ${String(response.status)} without an error body`,
    );
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.badResponse,
      `${method} ${path} response broke the contract: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** One GET of a binary body (a PDF). Error answers are the API's JSON envelope, as for `send`. */
async function sendDownload(path: string, accept: string, token: string): Promise<ApiDownload> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: 'GET',
      headers: { Accept: `${accept}, application/json`, Authorization: `Bearer ${token}` },
    });
  } catch (cause) {
    throw new ApiError(0, CLIENT_ERROR_CODES.network, `GET ${path} failed: ${String(cause)}`);
  }
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(await readJson(response));
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.badResponse,
      `GET ${path} returned HTTP ${String(response.status)} without an error body`,
    );
  }
  return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
}

/* ---------- Session renewal (SPEC implicit requirement 3) ---------- */

export const TOKEN_REFRESH_PATH = '/api/auth/token/refresh';

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

/**
 * Called after the session ended because the refresh token was refused (expired, revoked, or the
 * account is gone). The app uses it to drop cached data. Returns an unsubscribe function.
 */
export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

let refreshInFlight: Promise<string | null> | null = null;

/**
 * Exchanges the stored refresh token for a new access token. Single flight: every caller that
 * needs a token while a refresh is running waits for that same refresh, so a burst of 401s makes
 * one call. Resolves the new access token, or null when there is no session (no refresh token, or
 * the server refused it, in which case the user is signed out). Network and 5xx failures reject
 * with ApiError and keep the session, so a flaky connection never signs anyone out.
 */
export function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= runRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function runRefresh(): Promise<string | null> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (refreshToken === null) return null;
  // Signed out (or another account signed in) while the call ran: never revive the old session.
  const stillCurrent = () => useAuthStore.getState().refreshToken === refreshToken;
  try {
    const { access_token: accessToken } = await send(
      {
        method: 'POST',
        path: TOKEN_REFRESH_PATH,
        body: { refresh_token: refreshToken },
        schema: tokenRefreshResponseSchema,
      },
      null,
    );
    if (!stillCurrent()) return null;
    useAuthStore.getState().setAccessToken(accessToken);
    return accessToken;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 400)) {
      if (stillCurrent()) {
        useAuthStore.getState().clearSession();
        for (const listener of sessionExpiredListeners) listener();
      }
      return null;
    }
    throw error;
  }
}

/**
 * JSON request to the Hamro Pasal API. Authenticated requests (the default) send the in-memory
 * access token as `Authorization: Bearer` and renew it transparently:
 *   - no access token in memory but a refresh token in encrypted MMKV (e.g. after a relaunch):
 *     refresh first;
 *   - a 401 UNAUTHENTICATED answer (the token was refused): refresh once (shared with concurrent
 *     callers) and replay the request with the new token. If the refresh is refused, the user is
 *     signed out and the 401 surfaces. A 401 with any other code is the endpoint's own answer
 *     (e.g. INVALID_OTP for a wrong delivery code) and surfaces at once: replaying it would count
 *     a second wrong attempt.
 */
export async function apiRequest<T>(request: ApiRequest<T>): Promise<T> {
  if (request.authenticated === false) return send(request, null);

  let token = useAuthStore.getState().accessToken ?? (await refreshAccessToken());
  if (token === null) {
    throw new ApiError(401, CLIENT_ERROR_CODES.notSignedIn, 'No access token; sign in first');
  }
  try {
    return await send(request, token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || error.code !== TOKEN_REFUSED_CODE) {
      throw error;
    }
    // Another request may already have renewed the token while this one was in flight.
    const current = useAuthStore.getState().accessToken;
    token = current !== null && current !== token ? current : await refreshAccessToken();
    if (token === null) throw error;
    return send(request, token);
  }
}

/**
 * Authenticated GET of a binary body, with the same token renewal as `apiRequest`: refresh first
 * when only a refresh token exists, and one replay after a 401 UNAUTHENTICATED (the server refuses
 * the token before it does anything, so a replay never repeats an effect). Nothing else is retried.
 */
export async function apiDownload(path: string, accept: string): Promise<ApiDownload> {
  let token = useAuthStore.getState().accessToken ?? (await refreshAccessToken());
  if (token === null) {
    throw new ApiError(401, CLIENT_ERROR_CODES.notSignedIn, 'No access token; sign in first');
  }
  try {
    return await sendDownload(path, accept, token);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || error.code !== TOKEN_REFUSED_CODE) {
      throw error;
    }
    const current = useAuthStore.getState().accessToken;
    token = current !== null && current !== token ? current : await refreshAccessToken();
    if (token === null) throw error;
    return sendDownload(path, accept, token);
  }
}

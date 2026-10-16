import {
  errorBodySchema,
  sessionRefreshResponseSchema,
  tokenRefreshResponseSchema,
} from '@hamro-pasal/shared-types';
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
  /** Sent as JSON; a FormData is sent as it is (multipart/form-data, for file uploads). */
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
  /**
   * A GET whose answer is a file, not JSON (a vendor's PAN document): the bytes as a Blob, with
   * the same token renewal as `request`. The API marks such answers `no-store`.
   */
  download(path: string): Promise<Blob>;
  /**
   * Step 7.6: a POST whose answer is either a file (a CSV export, 200) or JSON (a queued export,
   * 202): the raw answer, with the same token renewal as `request`. Refusals throw ApiError.
   */
  postForFile(path: string, body: unknown): Promise<FileOrJsonAnswer>;
}

/** What postForFile answers: the status, the body as a Blob, and the file name it was sent as. */
export interface FileOrJsonAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: Blob;
  readonly fileName: string | null;
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
    // A FormData body gets no Content-Type from us: the browser must write it, because only it
    // knows the multipart boundary it generates ("multipart/form-data; boundary=…").
    const form = request.body instanceof FormData ? request.body : null;
    if (request.body !== undefined && form === null) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await options.fetch(buildUrl(baseUrl, request.path, request.query), {
        method: request.method,
        headers,
        // The refresh cookie must reach /api/auth (and be stored from it); never another origin.
        credentials: 'same-origin',
        ...(request.body === undefined ? {} : { body: form ?? JSON.stringify(request.body) }),
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
   * A vendor has no cookie: the refresh token of their sign-in (in memory) goes in the body of
   * POST /api/auth/token/refresh instead, as in the mobile app.
   */
  async function runRefresh(): Promise<string | null> {
    // Whose session this refresh started for (null: none yet, the page was just loaded).
    const signedInAs = () => session.getState().session?.user.id ?? null;
    const startedAs = signedInAs();
    const refreshToken = session.getState().session?.refreshToken;
    try {
      if (refreshToken !== undefined) {
        const renewed = await send(
          {
            method: 'POST',
            path: '/api/auth/token/refresh',
            schema: tokenRefreshResponseSchema,
            body: { refresh_token: refreshToken },
          },
          null,
        );
        if (signedInAs() !== startedAs) return null;
        session.getState().setAccessToken(renewed.access_token);
        return renewed.access_token;
      }
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

  async function sendDownload(path: string, accessToken: string): Promise<Blob> {
    let response: Response;
    try {
      response = await options.fetch(buildUrl(baseUrl, path, undefined), {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
        credentials: 'same-origin',
      });
    } catch (error: unknown) {
      throw new ApiError(
        0,
        CLIENT_ERROR_CODES.NETWORK_ERROR,
        error instanceof Error ? error.message : 'Network request failed',
      );
    }
    if (response.ok) return response.blob();
    const parsed = errorBodySchema.safeParse(parseJson(await response.text()));
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

  async function sendForFile(
    path: string,
    body: unknown,
    accessToken: string,
  ): Promise<FileOrJsonAnswer> {
    let response: Response;
    try {
      response = await options.fetch(buildUrl(baseUrl, path, undefined), {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
    } catch (error: unknown) {
      throw new ApiError(
        0,
        CLIENT_ERROR_CODES.NETWORK_ERROR,
        error instanceof Error ? error.message : 'Network request failed',
      );
    }
    if (response.ok) {
      const disposition = response.headers.get('content-disposition') ?? '';
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: await response.blob(),
        fileName: /filename="([^"]+)"/.exec(disposition)?.[1] ?? null,
      };
    }
    const parsed = errorBodySchema.safeParse(parseJson(await response.text()));
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

  /** Runs a call with the access token, renewing it once on a 401 UNAUTHENTICATED. */
  async function authorized<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
    const token = session.getState().session?.accessToken ?? null;
    if (token === null) {
      throw new ApiError(401, CLIENT_ERROR_CODES.NOT_SIGNED_IN, 'Sign in first');
    }
    try {
      return await call(token);
    } catch (error: unknown) {
      // Only an expired/invalid token is renewed; any other 401 is the answer itself.
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      if (error.code !== 'UNAUTHENTICATED') throw error;
      const current = session.getState().session?.accessToken ?? null;
      const renewed = current !== null && current !== token ? current : await refreshAccessToken();
      if (renewed === null) throw error;
      return call(renewed);
    }
  }

  return {
    publicRequest: (request) => send(request, null),

    restoreSession: async () => (await refreshAccessToken()) !== null,

    request: (request) => authorized((token) => send(request, token)),

    download: (path) => authorized((token) => sendDownload(path, token)),
    postForFile: (path, body) => authorized((token) => sendForFile(path, body, token)),
  };
}

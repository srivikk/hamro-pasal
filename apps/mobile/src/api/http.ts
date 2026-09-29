import { errorBodySchema } from '@hamro-pasal/shared-types';
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
export const CLIENT_ERROR_CODES = {
  /** No access token in memory: the request was not sent. */
  notSignedIn: 'NOT_SIGNED_IN',
  /** fetch() itself failed (offline, DNS, TLS, connection reset). */
  network: 'NETWORK_ERROR',
  /** The server answered, but not with the documented contract. */
  badResponse: 'UNEXPECTED_RESPONSE',
} as const;

interface ApiRequest<T> {
  method: 'GET' | 'POST';
  /** Path under the API base URL, starting with `/`. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Response body contract; the body is validated before it reaches the caller. */
  schema: z.ZodType<T>;
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
 * Authenticated JSON request to the Hamro Pasal API. The access token is read from the in-memory
 * auth store at call time (SPEC: tokens live in memory) and sent as `Authorization: Bearer`.
 */
export async function apiRequest<T>({
  method,
  path,
  query,
  body,
  schema,
}: ApiRequest<T>): Promise<T> {
  const token = useAuthStore.getState().accessToken;
  if (token === null) {
    throw new ApiError(401, CLIENT_ERROR_CODES.notSignedIn, 'No access token; sign in first');
  }

  // Built by hand: React Native's URLSearchParams polyfill is incomplete.
  const search =
    query === undefined
      ? ''
      : `?${Object.entries(query)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&')}`;
  const url = `${API_URL}${path}${search}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './http';

export const MAX_QUERY_RETRIES = 3;

/**
 * Retry policy for API reads: transient failures (network, 5xx, timeouts, rate limits) are retried
 * like the default; other 4xx answers (not signed in, not found, invalid request) cannot change by
 * retrying, so the error shows at once instead of after the whole backoff.
 */
export function retryTransientFailures(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (!(error instanceof ApiError)) return true;
  const { status } = error;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

/**
 * Defaults tuned for Nepal's volatile 3G/4G links: retry transient failures with capped
 * exponential backoff, and keep data fresh briefly so network flaps do not trigger refetch storms.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 24 * 60 * 60 * 1000,
        retry: MAX_QUERY_RETRIES,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      },
      mutations: {
        // Mutations (checkout, payments) carry idempotency keys and are retried explicitly by the caller.
        retry: 0,
      },
    },
  });
}

import { QueryClient } from '@tanstack/react-query';

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
        retry: 3,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      },
      mutations: {
        // Mutations (checkout, payments) carry idempotency keys and are retried explicitly by the caller.
        retry: 0,
      },
    },
  });
}

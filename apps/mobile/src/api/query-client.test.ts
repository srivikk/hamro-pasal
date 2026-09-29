import { ApiError } from './http';
import { createQueryClient, retryTransientFailures } from './query-client';

describe('createQueryClient', () => {
  it('retries queries with capped exponential backoff and never retries mutations', () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions();
    const retryDelay = queries?.retryDelay;
    if (typeof retryDelay !== 'function') throw new Error('retryDelay must be a function');

    expect(queries?.retry).toBe(3);
    expect([0, 1, 2, 3, 10].map((attempt) => retryDelay(attempt, new Error('offline')))).toEqual([
      1000, 2000, 4000, 8000, 30_000,
    ]);
    expect(mutations?.retry).toBe(0);
  });

  it('creates independent clients', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});

describe('retryTransientFailures', () => {
  const apiError = (status: number) => new ApiError(status, 'X', 'x');

  it('retries network failures, timeouts, rate limits and 5xx up to 3 times', () => {
    for (const error of [
      apiError(0),
      apiError(408),
      apiError(429),
      apiError(503),
      new Error('x'),
    ]) {
      expect(retryTransientFailures(0, error)).toBe(true);
      expect(retryTransientFailures(2, error)).toBe(true);
      expect(retryTransientFailures(3, error)).toBe(false);
    }
  });

  it('never retries other 4xx answers (not signed in, not found, invalid)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(retryTransientFailures(0, apiError(status))).toBe(false);
    }
  });
});

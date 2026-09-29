import { createQueryClient } from './query-client';

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

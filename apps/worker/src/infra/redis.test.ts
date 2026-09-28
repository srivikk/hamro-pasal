import { buildBullConnection } from './redis';

describe('buildBullConnection', () => {
  it('disables per-request retry limits as BullMQ workers require', () => {
    expect(buildBullConnection('redis://localhost:6379')).toEqual({
      url: 'redis://localhost:6379',
      maxRetriesPerRequest: null,
    });
  });
});

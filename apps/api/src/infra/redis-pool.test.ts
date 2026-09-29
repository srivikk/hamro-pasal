import type { Redis } from 'ioredis';

import { RedisConnectionPool } from './redis-pool';

function fakeConnection(id: number): Redis {
  return { id, quit: jest.fn().mockResolvedValue('OK') } as unknown as Redis;
}

describe('RedisConnectionPool', () => {
  it('never hands the same connection to two concurrent borrowers', async () => {
    let created = 0;
    const pool = new RedisConnectionPool(() => fakeConnection(++created), 3);
    const inUse = new Set<Redis>();
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        pool.withConnection(async (connection) => {
          expect(inUse.has(connection)).toBe(false);
          inUse.add(connection);
          maxConcurrent = Math.max(maxConcurrent, inUse.size);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inUse.delete(connection);
        }),
      ),
    );

    expect(created).toBe(3);
    expect(maxConcurrent).toBe(3);
  });

  it('returns the connection even when the work throws', async () => {
    const pool = new RedisConnectionPool(() => fakeConnection(1), 1);

    await expect(pool.withConnection(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    await expect(pool.withConnection(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('quits every connection on close and refuses new work', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const connection = { quit } as unknown as Redis;
    const pool = new RedisConnectionPool(() => connection, 2);
    await pool.withConnection(() => Promise.resolve());

    await pool.close();

    expect(quit).toHaveBeenCalledTimes(1);
    await expect(pool.withConnection(() => Promise.resolve())).rejects.toThrow('closed');
  });

  it('rejects invalid sizes', () => {
    expect(() => new RedisConnectionPool(() => fakeConnection(1), 0)).toThrow('positive integer');
  });
});

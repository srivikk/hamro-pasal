import type { Redis } from 'ioredis';

/**
 * A small fixed-size pool of dedicated Redis connections.
 *
 * WATCH / MULTI / EXEC state belongs to a connection. Two optimistic transactions interleaved on
 * one shared client would watch and exec each other's keys and silently lose the guarantee. So
 * every transaction attempt borrows a connection exclusively and returns it afterwards.
 */
export class RedisConnectionPool {
  private readonly idle: Redis[] = [];
  private readonly all: Redis[] = [];
  private readonly waiters: ((connection: Redis) => void)[] = [];
  private closed = false;

  constructor(
    private readonly createConnection: () => Redis,
    private readonly size: number,
  ) {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error('Redis pool size must be a positive integer');
    }
  }

  async withConnection<T>(work: (connection: Redis) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      return await work(connection);
    } finally {
      this.release(connection);
    }
  }

  private acquire(): Promise<Redis> {
    if (this.closed) {
      return Promise.reject(new Error('Redis pool is closed'));
    }
    const idle = this.idle.pop();
    if (idle !== undefined) {
      return Promise.resolve(idle);
    }
    if (this.all.length < this.size) {
      const connection = this.createConnection();
      this.all.push(connection);
      return Promise.resolve(connection);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(connection: Redis): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(connection);
    } else {
      this.idle.push(connection);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.all.map((connection) => connection.quit()));
    this.all.length = 0;
    this.idle.length = 0;
  }
}

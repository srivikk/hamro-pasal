import { request } from 'node:http';

import { startHealthServer, type HealthServer } from './health-server';

/** Task 8 (2026-10-22): the worker's GET /health, over a real socket on a free port. */
describe('worker health server', () => {
  let server: HealthServer | undefined;
  let clock = 1_000_000;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function call(
    path: string,
    method = 'GET',
  ): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    const port = server?.port ?? 0;
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function start(): Promise<HealthServer> {
    server = await startHealthServer({ port: 0, host: '127.0.0.1', now: () => clock });
    return server;
  }

  it('answers 200 with the uptime, never cached', async () => {
    await start();
    clock += 42_500;
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok', uptime_seconds: 42 });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await call('/health?probe=ecs')).status).toBe(200);
  });

  it('answers HEAD without a body', async () => {
    await start();
    const res = await call('/health', 'HEAD');
    expect([res.status, res.body]).toEqual([200, '']);
  });

  it('answers 503 once shutdown has begun', async () => {
    const health = await start();
    health.markStopping();
    const res = await call('/health');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'stopping' });
  });

  it('serves nothing else', async () => {
    await start();
    expect((await call('/')).status).toBe(404);
    expect((await call('/metrics')).status).toBe(404);
    const post = await call('/health', 'POST');
    expect([post.status, post.headers.allow]).toEqual([405, 'GET, HEAD']);
  });

  it('closes, and refuses connections afterwards', async () => {
    const health = await start();
    const { port } = health;
    await health.close();
    server = undefined;
    await expect(
      new Promise((resolve, reject) => {
        request({ host: '127.0.0.1', port, path: '/health' }, resolve).on('error', reject).end();
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('fails to start on a port already taken, instead of running without a health check', async () => {
    const first = await start();
    await expect(startHealthServer({ port: first.port, host: '127.0.0.1' })).rejects.toThrow(
      /EADDRINUSE/,
    );
  });
});

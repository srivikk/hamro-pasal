import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Task 8 (2026-10-22): the worker's health signal for the container orchestrator (ECS). The worker
 * has no HTTP API, so this tiny server answers one question: is the process up and not shutting
 * down?
 *
 *   GET / HEAD /health   200 {"status":"ok","uptime_seconds":n} while running,
 *                        503 {"status":"stopping"} once shutdown has begun
 *   any other path       404;  any other method on /health  405
 *
 * It is started after every consumer, queue and timer is running, so 200 means "started". On
 * shutdown it answers 503 at once and closes last, after the consumers have drained. It touches no database, broker or Redis: a dependency outage
 * must not make the orchestrator kill and restart every worker at once (the consumers already
 * retry, and their failures are dead-lettered).
 */
export interface HealthServer {
  /** The bound port (useful when started on port 0). */
  readonly port: number;
  /** From now on /health answers 503: the process is draining. */
  markStopping(): void;
  close(): Promise<void>;
}

export async function startHealthServer(options: {
  readonly port: number;
  readonly host: string;
  readonly now?: () => number;
}): Promise<HealthServer> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let stopping = false;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/health') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const body = stopping
      ? { status: 'stopping' }
      : { status: 'ok', uptime_seconds: Math.floor((now() - startedAt) / 1000) };
    res
      .writeHead(stopping ? 503 : 200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      })
      .end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  });
  // A health probe never needs a long-lived connection.
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    markStopping: () => {
      stopping = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

import { createServer } from 'node:http';

import { Redis } from 'ioredis';

import { createApp } from './app';
import { loadEnv } from './config/env';
import { buildContainerFromEnv } from './container';
import { attachRealtime } from './realtime/orders-namespace';

const env = loadEnv();
const container = buildContainerFromEnv(env);
const httpServer = createServer(createApp(container));

// Socket.io /orders (real-time order state) and /chat (dispute chat). The adapter needs its own
// pub and sub connections.
const redisPub = new Redis(env.REDIS_URL);
const redisSub = redisPub.duplicate();
const realtime = attachRealtime(httpServer, {
  accessTokenSecret: container.accessTokenSecret,
  orders: container.orders,
  vendors: container.vendorOrders,
  redis: { pub: redisPub, sub: redisSub },
  chat: { disputes: container.disputes, evidence: container.evidence },
});

httpServer.listen(env.API_PORT, () => {
  console.info(`[api] listening on :${String(env.API_PORT)} (${env.NODE_ENV})`);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[api] ${signal} received, closing HTTP and Socket.io servers`);
  // Closing Socket.io also closes the HTTP server it is attached to.
  realtime
    .close()
    .then(async () => {
      await Promise.all([redisPub.quit(), redisSub.quit()]);
      await container.close();
    })
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

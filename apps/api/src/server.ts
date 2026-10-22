import { createServer } from 'node:http';

import { Redis } from 'ioredis';

import { createApp } from './app';
import { loadEnv } from './config/env';
import { buildContainerFromEnv } from './container';
import { attachRealtime } from './realtime/orders-namespace';

const env = loadEnv();
const container = buildContainerFromEnv(env);
const httpServer = createServer(
  createApp(container, { corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS }),
);

// Socket.io /orders (real-time order state, rider telemetry) and /chat (dispute chat). The adapter needs its own
// pub and sub connections.
const redisPub = new Redis(env.REDIS_URL);
const redisSub = redisPub.duplicate();
const realtime = attachRealtime(httpServer, {
  accessTokenSecret: container.accessTokenSecret,
  orders: container.orders,
  vendors: container.vendorOrders,
  redis: { pub: redisPub, sub: redisSub },
  chat: { disputes: container.disputes, evidence: container.evidence },
  riders: { locations: container.riderLocations, deliveries: container.deliveries },
});

// 2026-10-21: messages sent over HTTP (the admin dashboard) reach the same /chat rooms.
container.chatBroadcaster.attach(realtime.chat);

httpServer.listen(env.API_PORT, () => {
  console.info(`[api] listening on :${String(env.API_PORT)} (${env.NODE_ENV})`);
  if (container.mockPayments !== undefined) {
    console.warn(
      '[api] MOCK_SERVICES is on: SMS and IVR are logged, and POST /api/test/mock-payment is served',
    );
  }
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

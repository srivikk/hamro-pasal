import { createApp } from './app';
import { loadEnv } from './config/env';

const env = loadEnv();
const server = createApp().listen(env.API_PORT, () => {
  console.info(`[api] listening on :${String(env.API_PORT)} (${env.NODE_ENV})`);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[api] ${signal} received, closing HTTP server`);
  server.close((err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

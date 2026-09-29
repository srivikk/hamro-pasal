import { createApp } from './app';
import { loadEnv } from './config/env';
import { buildContainerFromEnv } from './container';

const env = loadEnv();
const container = buildContainerFromEnv(env);
const server = createApp(container).listen(env.API_PORT, () => {
  console.info(`[api] listening on :${String(env.API_PORT)} (${env.NODE_ENV})`);
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[api] ${signal} received, closing HTTP server`);
  server.close((err) => {
    container.close().then(
      () => process.exit(err ? 1 : 0),
      (closeError: unknown) => {
        console.error(closeError);
        process.exit(1);
      },
    );
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

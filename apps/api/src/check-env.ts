import { loadEnvOrExit } from './config/env';

/**
 * Phase 7 (2026-10-22): `node dist/check-env.js` validates the environment the API and the worker
 * would boot with (they share one schema) and exits 1 with the problems if it is not valid. Run by
 * the deploy pipeline before migrations and before any new container takes traffic.
 */
const env = loadEnvOrExit('check-env');
console.info(`[check-env] environment is valid for NODE_ENV=${env.NODE_ENV}`);

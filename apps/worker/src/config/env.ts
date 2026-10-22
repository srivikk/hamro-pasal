import { InvalidEnvError, parseServerEnv, type ServerEnv } from '@hamro-pasal/shared-types';

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parseServerEnv(source);
}

/**
 * Phase 7 (2026-10-22): the boot-time gate. An invalid environment (a missing production key, a
 * mock adapter in production, plain http where https is required, …) stops the process at once
 * with the list of problems and exit code 1, before any connection is opened or traffic accepted.
 * The problems name keys and rules, never values.
 */
export function loadEnvOrExit(
  service: string,
  source: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = (code) => process.exit(code),
): ServerEnv {
  try {
    return parseServerEnv(source);
  } catch (error) {
    if (!(error instanceof InvalidEnvError)) throw error;
    console.error(`[${service}] refusing to start. ${error.message}`);
    return exit(1);
  }
}

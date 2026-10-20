import { existsSync } from 'node:fs';
import path from 'node:path';

import { useTestKafkaBroker } from '../src/testing';

/**
 * Loads the root .env before Jest creates the per-file sandboxes (which copy process.env), then
 * points them at the kafka-test broker, never the dev one.
 */
export default function globalSetup(): void {
  const rootEnv = path.resolve(__dirname, '..', '..', '..', '.env');
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  useTestKafkaBroker();
}

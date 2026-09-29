import { existsSync } from 'node:fs';
import path from 'node:path';

/** Loads the root .env before Jest creates the per-file sandboxes (which copy process.env). */
export default function globalSetup(): void {
  const rootEnv = path.resolve(__dirname, '..', '..', '..', '.env');
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}

import { parseServerEnv, type ServerEnv } from '@hamro-pasal/shared-types';

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  return parseServerEnv(source);
}

import type { ConnectionOptions } from 'bullmq';

/** BullMQ workers require `maxRetriesPerRequest: null` so blocking commands never time out. */
export function buildBullConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

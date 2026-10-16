import { S3Client } from '@aws-sdk/client-s3';
import type { ServerEnv } from '@hamro-pasal/shared-types';

import { LocalObjectStore, S3ObjectStore, type ObjectStore } from './object-store';

/**
 * The private store (KYC documents, data exports): the private bucket under STORAGE_DRIVER=S3,
 * else `UPLOADS_PRIVATE_DIR` (or `defaultDir`), a directory nothing serves. parseServerEnv has
 * already checked that S3 has what it needs.
 */
export function privateObjectStoreFromEnv(
  env: Pick<
    ServerEnv,
    | 'STORAGE_DRIVER'
    | 'UPLOADS_PRIVATE_DIR'
    | 'S3_PRIVATE_BUCKET'
    | 'S3_REGION'
    | 'S3_ENDPOINT'
    | 'S3_FORCE_PATH_STYLE'
    | 'S3_ACCESS_KEY_ID'
    | 'S3_SECRET_ACCESS_KEY'
  >,
  defaultDir: string,
): ObjectStore {
  if (env.STORAGE_DRIVER === 'LOCAL') {
    return new LocalObjectStore(env.UPLOADS_PRIVATE_DIR ?? defaultDir);
  }
  if (env.S3_PRIVATE_BUCKET === undefined) {
    throw new Error('STORAGE_DRIVER=S3 needs S3_PRIVATE_BUCKET');
  }
  const client = new S3Client({
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT === undefined ? {} : { endpoint: env.S3_ENDPOINT }),
    ...(env.S3_ACCESS_KEY_ID === undefined || env.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }),
  });
  return new S3ObjectStore(client, env.S3_PRIVATE_BUCKET);
}

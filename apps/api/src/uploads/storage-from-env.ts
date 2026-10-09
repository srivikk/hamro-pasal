import { S3Client } from '@aws-sdk/client-s3';
import type { ServerEnv } from '@hamro-pasal/shared-types';

import {
  LocalEvidenceStorage,
  ObjectEvidenceStorage,
  type EvidenceStorage,
} from './evidence-storage';
import { KycDocumentStorage } from './kyc-document-storage';
import { LocalObjectStore, S3ObjectStore, type S3CommandSender } from './object-store';
import {
  LocalProductImageStorage,
  ObjectProductImageStorage,
  type ProductImageStorage,
} from './product-image-storage';
import { PromotionImageStorage } from './promotion-image-storage';

/** Every place the API keeps a file. */
export interface FileStorage {
  readonly evidence: EvidenceStorage;
  readonly productImages: ProductImageStorage;
  readonly promotionImages: PromotionImageStorage;
  readonly kycDocuments: KycDocumentStorage;
}

/**
 * Development and tests: public files under `publicDir` (served by the API at the base URL's
 * path), private documents under `privateDir`, which nothing serves.
 */
export function localFileStorage(
  publicDir: string,
  privateDir: string,
  publicBaseUrl: string,
): FileStorage {
  return {
    evidence: new LocalEvidenceStorage(publicDir, publicBaseUrl),
    productImages: new LocalProductImageStorage(publicDir, publicBaseUrl),
    promotionImages: new PromotionImageStorage(new LocalObjectStore(publicDir), publicBaseUrl),
    kycDocuments: new KycDocumentStorage(new LocalObjectStore(privateDir)),
  };
}

export interface S3StorageConfig {
  readonly publicBucket: string;
  readonly privateBucket: string;
  /** Where the public bucket is read: the CDN, or the bucket's public domain. */
  readonly publicBaseUrl: string;
}

/** Production: one public bucket behind `publicBaseUrl`, and one private bucket for KYC. */
export function s3FileStorage(client: S3CommandSender, config: S3StorageConfig): FileStorage {
  const publicStore = new S3ObjectStore(client, config.publicBucket);
  return {
    evidence: new ObjectEvidenceStorage(publicStore, config.publicBaseUrl),
    productImages: new ObjectProductImageStorage(publicStore, config.publicBaseUrl),
    promotionImages: new PromotionImageStorage(publicStore, config.publicBaseUrl),
    kycDocuments: new KycDocumentStorage(new S3ObjectStore(client, config.privateBucket)),
  };
}

export interface LocalStorageDefaults {
  readonly publicDir: string;
  readonly privateDir: string;
}

/** Picks the storage by STORAGE_DRIVER (parseServerEnv has already checked what each needs). */
export function fileStorageFromEnv(env: ServerEnv, defaults: LocalStorageDefaults): FileStorage {
  if (env.STORAGE_DRIVER === 'LOCAL') {
    return localFileStorage(
      env.UPLOADS_DIR ?? defaults.publicDir,
      env.UPLOADS_PRIVATE_DIR ?? defaults.privateDir,
      env.UPLOADS_PUBLIC_BASE_URL ?? `http://localhost:${String(env.API_PORT)}/uploads`,
    );
  }
  const {
    S3_PUBLIC_BUCKET: publicBucket,
    S3_PRIVATE_BUCKET: privateBucket,
    S3_PUBLIC_BASE_URL: publicBaseUrl,
  } = env;
  if (publicBucket === undefined || privateBucket === undefined || publicBaseUrl === undefined) {
    throw new Error(
      'STORAGE_DRIVER=S3 needs S3_PUBLIC_BUCKET, S3_PRIVATE_BUCKET, S3_PUBLIC_BASE_URL',
    );
  }
  const client = new S3Client({
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    ...(env.S3_ENDPOINT === undefined ? {} : { endpoint: env.S3_ENDPOINT }),
    // Without keys the SDK's own chain applies (an ECS task role, an instance profile).
    ...(env.S3_ACCESS_KEY_ID === undefined || env.S3_SECRET_ACCESS_KEY === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          },
        }),
  });
  return s3FileStorage(client, { publicBucket, privateBucket, publicBaseUrl });
}

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

export interface PutObjectOptions {
  readonly contentType: string;
  /** The `Cache-Control` the object is served with (S3 only; local files have none). */
  readonly cacheControl?: string;
}

/**
 * A flat key → bytes store: an S3-compatible bucket (Cloudflare R2, AWS S3) in production, a
 * directory on a development machine. It knows nothing about URLs, owners or image types; the
 * storages built on it (evidence, product photos, promotion images, KYC documents) do.
 */
export interface ObjectStore {
  /** Stores a new object. Keys are never reused, so this never overwrites. */
  put(key: string, bytes: Buffer, options: PutObjectOptions): Promise<void>;
  /** The object's bytes, or null when there is no such object. */
  get(key: string): Promise<Buffer | null>;
  /** Deletes the object. An object that is already gone is not an error. */
  delete(key: string): Promise<void>;
}

/** Path segments of letters, digits, `_`, `-` and `.`; never empty, `.` or `..`. */
const KEY_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/;

export class InvalidObjectKeyError extends Error {
  constructor(readonly key: string) {
    super(`Not an object key: ${JSON.stringify(key)}`);
    this.name = 'InvalidObjectKeyError';
  }
}

/**
 * Refuses any key the storages do not generate themselves. Nothing a client sends is ever a key,
 * but a key also comes back from the database: this is the last line before a path or a bucket.
 */
export function assertObjectKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..')) throw new InvalidObjectKeyError(key);
}

/** Development and tests: `<rootDir>/<key>`. */
export class LocalObjectStore implements ObjectStore {
  constructor(readonly rootDir: string) {}

  /** The content type and cache policy are the serving side's: a file on disk has neither. */
  async put(key: string, bytes: Buffer, _options?: PutObjectOptions): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  private pathOf(key: string): string {
    assertObjectKey(key);
    return join(this.rootDir, ...key.split('/'));
  }
}

/** By shape, not `instanceof`: an fs error can come from another realm (Jest's sandbox). */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorNameOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null;
  return typeof error.name === 'string' ? error.name : null;
}

/** The part of a GetObject body this store reads. */
export interface S3ObjectBody {
  transformToByteArray(): Promise<Uint8Array>;
}

/** The three calls this store makes: what `S3Client` offers, and all a test has to stand in for. */
export interface S3CommandSender {
  send(command: PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
  send(command: GetObjectCommand): Promise<{ readonly Body?: S3ObjectBody | undefined }>;
}

/**
 * One bucket of an S3-compatible service.
 *
 * - `put` is a single PutObject with the bytes as its body: every stored image has already been
 *   re-encoded to under 300 KB in memory, so there is no temporary file and no multipart upload.
 * - `delete` is S3's own idempotent DeleteObject (a missing key is a success).
 * - Nothing here sets an ACL: whether a bucket is public is the bucket's own configuration.
 */
export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3CommandSender,
    readonly bucket: string,
  ) {}

  async put(key: string, bytes: Buffer, options: PutObjectOptions): Promise<void> {
    assertObjectKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        ContentType: options.contentType,
        ...(options.cacheControl === undefined ? {} : { CacheControl: options.cacheControl }),
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertObjectKey(key);
    try {
      const { Body: body } = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (body === undefined) return null;
      return Buffer.from(await body.transformToByteArray());
    } catch (error: unknown) {
      const name = errorNameOf(error);
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

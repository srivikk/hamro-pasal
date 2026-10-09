import { DeleteObjectCommand, PutObjectCommand, type GetObjectCommand } from '@aws-sdk/client-s3';

import type { S3CommandSender, S3ObjectBody } from '../../src/uploads/object-store';

export interface FakeS3Object {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly cacheControl: string | undefined;
}

type Operation = 'PutObject' | 'GetObject' | 'DeleteObject';

/**
 * An in-memory S3: what `S3ObjectStore` sends, applied to a map of `<bucket>/<key>`. It stands
 * where `S3Client` would, so the commands the code builds are the real SDK ones.
 */
export class FakeS3 implements S3CommandSender {
  readonly objects = new Map<string, FakeS3Object>();
  /** Every command received, in order. */
  readonly log: { operation: Operation; bucket: string; key: string }[] = [];
  /** Operations that fail with a service error until removed. */
  readonly failing = new Set<Operation>();

  send(command: PutObjectCommand | DeleteObjectCommand): Promise<unknown>;
  send(command: GetObjectCommand): Promise<{ readonly Body?: S3ObjectBody | undefined }>;
  send(
    command: PutObjectCommand | DeleteObjectCommand | GetObjectCommand,
  ): Promise<{ readonly Body?: S3ObjectBody | undefined }> {
    const bucket = command.input.Bucket ?? '';
    const key = command.input.Key ?? '';
    const id = `${bucket}/${key}`;

    if (command instanceof PutObjectCommand) {
      this.record('PutObject', bucket, key);
      const body = command.input.Body;
      if (!Buffer.isBuffer(body)) return Promise.reject(new Error('FakeS3 takes Buffer bodies'));
      if (command.input.ContentLength !== body.length) {
        return Promise.reject(new Error('ContentLength does not match the body'));
      }
      if (this.failing.has('PutObject')) return Promise.reject(serviceError('InternalError'));
      this.objects.set(id, {
        body,
        contentType: command.input.ContentType,
        cacheControl: command.input.CacheControl,
      });
      return Promise.resolve({});
    }
    if (command instanceof DeleteObjectCommand) {
      this.record('DeleteObject', bucket, key);
      if (this.failing.has('DeleteObject')) return Promise.reject(serviceError('InternalError'));
      // S3 answers 204 whether or not the key existed.
      this.objects.delete(id);
      return Promise.resolve({});
    }
    this.record('GetObject', bucket, key);
    if (this.failing.has('GetObject')) return Promise.reject(serviceError('InternalError'));
    const found = this.objects.get(id);
    if (found === undefined) return Promise.reject(serviceError('NoSuchKey'));
    return Promise.resolve({
      Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(found.body)) },
    });
  }

  /** The keys held in `bucket`, sorted. */
  keys(bucket: string): string[] {
    return [...this.objects.keys()]
      .filter((id) => id.startsWith(`${bucket}/`))
      .map((id) => id.slice(bucket.length + 1))
      .sort();
  }

  private record(operation: Operation, bucket: string, key: string): void {
    this.log.push({ operation, bucket, key });
  }
}

function serviceError(name: string): Error {
  const error = new Error(`${name}: simulated S3 failure`);
  error.name = name;
  return error;
}

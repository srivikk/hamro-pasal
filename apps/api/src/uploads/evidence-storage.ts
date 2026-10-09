import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

import { LocalObjectStore, type ObjectStore } from './object-store';
import { mountPathOf, PublicFileArea } from './public-files';

/**
 * The image type of `bytes`, read from the file's own signature (never from the client's
 * Content-Type or file name), or null when it is not a JPEG, PNG or WebP image.
 */
export function sniffEvidenceType(bytes: Buffer): DisputeEvidenceContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export interface StoredEvidence {
  readonly url: string;
  readonly contentType: DisputeEvidenceContentType;
}

/** Where dispute evidence images live (an S3-compatible bucket, SPEC infrastructure §3). */
export interface EvidenceStorage {
  save(
    orderId: string,
    bytes: Buffer,
    contentType: DisputeEvidenceContentType,
  ): Promise<StoredEvidence>;
  /** Whether `url` points at evidence this storage issued for `orderId`. */
  isEvidenceUrl(orderId: string, url: string): boolean;
  /**
   * Deletes an evidence image this storage issued; false (and nothing deleted) for any other
   * URL. Nothing calls it for a message that was sent: a dispute's transcript keeps its photos.
   */
  deleteFile(url: string): Promise<boolean>;
}

/**
 * Evidence in an object store: `dispute-evidence/<orderId>/<uuid>.<ext>`, read at
 * `<publicBaseUrl>/dispute-evidence/<orderId>/<uuid>.<ext>`. File names are random uuids, so
 * URLs cannot be guessed from an order id.
 */
export class ObjectEvidenceStorage implements EvidenceStorage {
  private readonly files: PublicFileArea;

  constructor(store: ObjectStore, publicBaseUrl: string) {
    this.files = new PublicFileArea(store, publicBaseUrl, 'dispute-evidence');
  }

  get publicBaseUrl(): string {
    return this.files.publicBaseUrl;
  }

  async save(
    orderId: string,
    bytes: Buffer,
    contentType: DisputeEvidenceContentType,
  ): Promise<StoredEvidence> {
    return { url: await this.files.save(orderId, bytes, contentType), contentType };
  }

  isEvidenceUrl(orderId: string, url: string): boolean {
    return this.files.keyOf(url, orderId) !== null;
  }

  deleteFile(url: string): Promise<boolean> {
    return this.files.deleteFile(url);
  }
}

/**
 * Development and tests: the same layout under `rootDir`, which the API serves statically at the
 * base URL's path (see createApp).
 */
export class LocalEvidenceStorage extends ObjectEvidenceStorage {
  constructor(
    readonly rootDir: string,
    publicBaseUrl: string,
  ) {
    super(new LocalObjectStore(rootDir), publicBaseUrl);
  }

  /** The path the API must serve `rootDir` under, taken from the public base URL. */
  get mountPath(): string {
    return mountPathOf(this.publicBaseUrl);
  }
}

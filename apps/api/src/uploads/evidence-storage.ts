import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

const EXTENSIONS: Record<DisputeEvidenceContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

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

/** Where dispute evidence images live (Cloudflare R2 in production, SPEC infrastructure §3). */
export interface EvidenceStorage {
  save(
    orderId: string,
    bytes: Buffer,
    contentType: DisputeEvidenceContentType,
  ): Promise<StoredEvidence>;
  /** Whether `url` points at evidence this storage issued for `orderId`. */
  isEvidenceUrl(orderId: string, url: string): boolean;
}

/**
 * Local stand-in for R2: writes `<rootDir>/dispute-evidence/<orderId>/<uuid>.<ext>` and hands out
 * `<publicBaseUrl>/dispute-evidence/<orderId>/<uuid>.<ext>`, which the API serves statically
 * (see createApp). File names are random uuids, so URLs cannot be guessed from an order id.
 */
export class LocalEvidenceStorage implements EvidenceStorage {
  readonly publicBaseUrl: string;

  constructor(
    readonly rootDir: string,
    publicBaseUrl: string,
  ) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  /** The path the API must serve `rootDir` under, taken from the public base URL. */
  get mountPath(): string {
    const path = new URL(this.publicBaseUrl).pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  }

  async save(
    orderId: string,
    bytes: Buffer,
    contentType: DisputeEvidenceContentType,
  ): Promise<StoredEvidence> {
    const name = `${randomUUID()}.${EXTENSIONS[contentType]}`;
    const directory = join(this.rootDir, 'dispute-evidence', orderId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), bytes, { flag: 'wx' });
    return { url: `${this.evidencePrefix(orderId)}${name}`, contentType };
  }

  isEvidenceUrl(orderId: string, url: string): boolean {
    const prefix = this.evidencePrefix(orderId);
    return (
      url.startsWith(prefix) && /^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(url.slice(prefix.length))
    );
  }

  private evidencePrefix(orderId: string): string {
    return `${this.publicBaseUrl}/dispute-evidence/${orderId}/`;
  }
}

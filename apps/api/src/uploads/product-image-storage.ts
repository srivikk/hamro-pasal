import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

/** The image types of a product photo are the ones accepted as dispute evidence. */
export type ProductImageContentType = DisputeEvidenceContentType;

const EXTENSIONS: Record<ProductImageContentType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Where product photos live (Cloudflare R2 in production, SPEC infrastructure §3). */
export interface ProductImageStorage {
  /** Stores one photo of `productId` and returns the public URL to keep in `image_urls`. */
  save(productId: string, bytes: Buffer, contentType: ProductImageContentType): Promise<string>;
  /**
   * Deletes a photo this storage issued for `productId`. A URL it did not issue (an external one,
   * or another product's) is left alone, and so is a file that is already gone.
   */
  remove(productId: string, url: string): Promise<void>;
}

/**
 * Local stand-in for R2 (Phase 19): writes `<rootDir>/product-images/<productId>/<uuid>.<ext>` and
 * hands out `<publicBaseUrl>/product-images/<productId>/<uuid>.<ext>`, which the API serves
 * statically (see createApp). It shares `rootDir` and the base URL with LocalEvidenceStorage.
 */
export class LocalProductImageStorage implements ProductImageStorage {
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
    productId: string,
    bytes: Buffer,
    contentType: ProductImageContentType,
  ): Promise<string> {
    const name = `${randomUUID()}.${EXTENSIONS[contentType]}`;
    const directory = join(this.rootDir, 'product-images', productId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), bytes, { flag: 'wx' });
    return `${this.prefix(productId)}${name}`;
  }

  async remove(productId: string, url: string): Promise<void> {
    const prefix = this.prefix(productId);
    if (!url.startsWith(prefix)) return;
    const name = url.slice(prefix.length);
    // Only a name this storage generates: nothing in a URL can point outside the directory.
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(name)) return;
    await rm(join(this.rootDir, 'product-images', productId, name), { force: true });
  }

  private prefix(productId: string): string {
    return `${this.publicBaseUrl}/product-images/${productId}/`;
  }
}

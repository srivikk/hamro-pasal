import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

import { LocalObjectStore, type ObjectStore } from './object-store';
import { mountPathOf, PublicFileArea } from './public-files';

/** The image types of a product photo are the ones accepted as dispute evidence. */
export type ProductImageContentType = DisputeEvidenceContentType;

/** Where product photos live (an S3-compatible bucket, SPEC infrastructure §3). */
export interface ProductImageStorage {
  /** Stores one photo of `productId` and returns the public URL to keep in `image_urls`. */
  save(productId: string, bytes: Buffer, contentType: ProductImageContentType): Promise<string>;
  /**
   * Deletes a photo this storage issued for `productId`. A URL it did not issue (an external one,
   * or another product's) is left alone, and so is a file that is already gone.
   */
  remove(productId: string, url: string): Promise<void>;
  /**
   * Deletes a product photo this storage issued, whichever product it belonged to; false (and
   * nothing deleted) for any other URL.
   */
  deleteFile(url: string): Promise<boolean>;
}

/**
 * Product photos in an object store: `product-images/<productId>/<uuid>.<ext>`, read at
 * `<publicBaseUrl>/product-images/<productId>/<uuid>.<ext>`.
 */
export class ObjectProductImageStorage implements ProductImageStorage {
  private readonly files: PublicFileArea;

  constructor(store: ObjectStore, publicBaseUrl: string) {
    this.files = new PublicFileArea(store, publicBaseUrl, 'product-images');
  }

  get publicBaseUrl(): string {
    return this.files.publicBaseUrl;
  }

  save(productId: string, bytes: Buffer, contentType: ProductImageContentType): Promise<string> {
    return this.files.save(productId, bytes, contentType);
  }

  async remove(productId: string, url: string): Promise<void> {
    await this.files.deleteFile(url, productId);
  }

  deleteFile(url: string): Promise<boolean> {
    return this.files.deleteFile(url);
  }
}

/**
 * Development and tests (Phase 19): the same layout under `rootDir`, which the API serves
 * statically (see createApp). It shares `rootDir` and the base URL with LocalEvidenceStorage.
 */
export class LocalProductImageStorage extends ObjectProductImageStorage {
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

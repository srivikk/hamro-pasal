import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

import type { ObjectStore } from './object-store';
import { PublicFileArea } from './public-files';

/**
 * Home promotion artwork (Phase 34): `promotions/<uuid>.<ext>` in the public bucket. An image is
 * uploaded before the promotion that uses it is saved, so it has no owner in its key.
 */
export class PromotionImageStorage {
  private readonly files: PublicFileArea;

  constructor(store: ObjectStore, publicBaseUrl: string) {
    this.files = new PublicFileArea(store, publicBaseUrl, 'promotions');
  }

  /** Stores the image and returns the absolute public URL to save as `image_url`. */
  save(bytes: Buffer, contentType: DisputeEvidenceContentType): Promise<string> {
    return this.files.save(null, bytes, contentType);
  }

  /** Whether `url` is an image this storage issued (a pasted external URL is not). */
  owns(url: string): boolean {
    return this.files.keyOf(url, null) !== null;
  }

  /** Deletes an image this storage issued; false (and nothing deleted) for any other URL. */
  deleteFile(url: string): Promise<boolean> {
    return this.files.deleteFile(url, null);
  }
}

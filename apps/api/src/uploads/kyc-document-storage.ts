import { randomUUID } from 'node:crypto';

import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

import type { ObjectStore } from './object-store';
import { IMAGE_EXTENSIONS } from './public-files';

const PAN_DOCUMENT_KEY = /^kyc\/pan\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

const CONTENT_TYPES: Readonly<Record<string, DisputeEvidenceContentType>> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface StoredDocument {
  readonly bytes: Buffer;
  readonly contentType: DisputeEvidenceContentType;
}

/**
 * Vendors' KYC documents (Phase 34), in the **private** store: a bucket without public access,
 * or on a development machine a directory outside the served uploads.
 *
 * There is no URL here on purpose. What is kept in `vendors.pan_document_url` is the object key
 * (`kyc/pan/<vendorId>/<uuid>.<ext>`), and the only way to the bytes is `read`, behind the API's
 * own authorisation (the Super Admin's compliance view).
 */
export class KycDocumentStorage {
  constructor(private readonly store: ObjectStore) {}

  /** Stores a PAN document under a new key and returns that key. */
  async savePanDocument(
    vendorId: string,
    bytes: Buffer,
    contentType: DisputeEvidenceContentType,
  ): Promise<string> {
    const key = `kyc/pan/${vendorId}/${randomUUID()}.${IMAGE_EXTENSIONS[contentType]}`;
    if (!PAN_DOCUMENT_KEY.test(key)) throw new Error(`Not a vendor id: ${vendorId}`);
    await this.store.put(key, bytes, { contentType, cacheControl: 'private, no-store' });
    return key;
  }

  /** The document, or null when the key is not one of ours or its object is gone. */
  async read(key: string): Promise<StoredDocument | null> {
    const extension = PAN_DOCUMENT_KEY.exec(key)?.[1];
    const contentType = extension === undefined ? undefined : CONTENT_TYPES[extension];
    if (contentType === undefined) return null;
    const bytes = await this.store.get(key);
    return bytes === null ? null : { bytes, contentType };
  }

  /**
   * Deletes a document this storage issued; false (and nothing deleted) for anything else. An
   * object that is already gone counts as deleted.
   */
  async deleteFile(key: string): Promise<boolean> {
    if (!PAN_DOCUMENT_KEY.test(key)) return false;
    await this.store.delete(key);
    return true;
  }
}

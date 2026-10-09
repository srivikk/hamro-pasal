import { randomUUID } from 'node:crypto';

import type { DisputeEvidenceContentType } from '@hamro-pasal/shared-types';

import type { ObjectStore } from './object-store';

export const IMAGE_EXTENSIONS: Readonly<Record<DisputeEvidenceContentType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** `<uuid>.<ext>`: the only file names the storages generate. */
export const STORED_FILE_NAME = /^[0-9a-f-]{36}\.(jpg|png|webp)$/;
const SCOPE = /^[0-9a-f-]{36}$/;

/**
 * Public objects are named by a random uuid and never rewritten, so a CDN and a phone may keep
 * them for good.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * One kind of publicly readable file (`dispute-evidence`, `product-images`, `promotions`) in an
 * object store: `<area>/[<scope>/]<uuid>.<ext>`, read at `<publicBaseUrl>/<that key>`.
 *
 * The URL is the only thing kept in the database, so deleting starts from a URL: `keyOf` turns
 * one back into a key **only** when this area issued it. An external URL, another area's, another
 * scope's, or one with anything but a generated file name is never touched.
 */
export class PublicFileArea {
  readonly publicBaseUrl: string;

  constructor(
    private readonly store: ObjectStore,
    publicBaseUrl: string,
    private readonly area: string,
  ) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
  }

  /** Stores the bytes under a new name and returns the public URL. `scope` is the owner's id. */
  async save(
    scope: string | null,
    bytes: Buffer,
    contentType: DisputeEvidenceContentType,
  ): Promise<string> {
    if (scope !== null && !SCOPE.test(scope)) throw new Error(`Not a file scope: ${scope}`);
    const name = `${randomUUID()}.${IMAGE_EXTENSIONS[contentType]}`;
    const key = scope === null ? `${this.area}/${name}` : `${this.area}/${scope}/${name}`;
    await this.store.put(key, bytes, { contentType, cacheControl: IMMUTABLE_CACHE_CONTROL });
    return `${this.publicBaseUrl}/${key}`;
  }

  /**
   * The object key behind a URL this area issued, else null. With `scope`, only that owner's
   * files count (null: only files stored without an owner).
   */
  keyOf(url: string, scope?: string | null): string | null {
    const prefix = `${this.publicBaseUrl}/${this.area}/`;
    if (!url.startsWith(prefix)) return null;
    const segments = url.slice(prefix.length).split('/');
    const name = segments.at(-1) ?? '';
    const owner = segments.length === 2 ? (segments[0] ?? '') : null;
    if (segments.length > 2 || !STORED_FILE_NAME.test(name)) return null;
    if (owner !== null && !SCOPE.test(owner)) return null;
    if (scope !== undefined && scope !== owner) return null;
    return owner === null ? `${this.area}/${name}` : `${this.area}/${owner}/${name}`;
  }

  /**
   * Deletes the object behind a URL this area issued. Returns false, and deletes nothing, for any
   * other URL. An object that is already gone counts as deleted.
   */
  async deleteFile(url: string, scope?: string | null): Promise<boolean> {
    const key = this.keyOf(url, scope);
    if (key === null) return false;
    await this.store.delete(key);
    return true;
  }
}

/** The path the API must serve a local directory under, taken from the public base URL. */
export function mountPathOf(publicBaseUrl: string): string {
  const path = new URL(publicBaseUrl).pathname.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertObjectKey,
  InvalidObjectKeyError,
  LocalObjectStore,
  S3ObjectStore,
} from './object-store';
import { privateObjectStoreFromEnv } from './private-store';

const base = {
  UPLOADS_PRIVATE_DIR: undefined,
  S3_PRIVATE_BUCKET: undefined,
  S3_REGION: 'auto',
  S3_ENDPOINT: undefined,
  S3_FORCE_PATH_STYLE: false,
  S3_ACCESS_KEY_ID: undefined,
  S3_SECRET_ACCESS_KEY: undefined,
} as const;

describe('the private object store (step 7.6)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hp-storage-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is a directory under STORAGE_DRIVER=LOCAL, storing, reading and deleting by key', async () => {
    const store = privateObjectStoreFromEnv({ ...base, STORAGE_DRIVER: 'LOCAL' }, dir);
    expect(store).toBeInstanceOf(LocalObjectStore);

    const key = 'exports/0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c.zip';
    await store.put(key, Buffer.from('zip'), { contentType: 'application/zip' });
    expect((await store.get(key))?.toString()).toBe('zip');
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    // Deleting what is gone is not an error.
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('is the private bucket under STORAGE_DRIVER=S3, and needs one', () => {
    expect(
      privateObjectStoreFromEnv(
        { ...base, STORAGE_DRIVER: 'S3', S3_PRIVATE_BUCKET: 'hp-private' },
        dir,
      ),
    ).toBeInstanceOf(S3ObjectStore);
    expect(() => privateObjectStoreFromEnv({ ...base, STORAGE_DRIVER: 'S3' }, dir)).toThrow(
      'S3_PRIVATE_BUCKET',
    );
  });

  it('refuses keys it did not make', () => {
    expect(() => {
      assertObjectKey('exports/../../etc/passwd');
    }).toThrow(InvalidObjectKeyError);
    expect(() => {
      assertObjectKey('noslash');
    }).toThrow(InvalidObjectKeyError);
  });
});

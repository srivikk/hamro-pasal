import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseServerEnv } from '@hamro-pasal/shared-types';

import { FakeS3 } from '../../test/support/fake-s3';
import { LocalEvidenceStorage, ObjectEvidenceStorage } from './evidence-storage';
import {
  assertObjectKey,
  InvalidObjectKeyError,
  LocalObjectStore,
  S3ObjectStore,
} from './object-store';
import { ObjectProductImageStorage } from './product-image-storage';
import { IMMUTABLE_CACHE_CONTROL } from './public-files';
import { fileStorageFromEnv, localFileStorage, s3FileStorage } from './storage-from-env';

const WEBP = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 stored-image-bytes', 'latin1');
const CDN = 'https://cdn.hamropasal.test';
const PUBLIC = 'hp-public';
const PRIVATE = 'hp-private';

describe('assertObjectKey', () => {
  it('accepts the keys the storages generate', () => {
    const id = randomUUID();
    for (const key of [
      `promotions/${id}.webp`,
      `product-images/${id}/${id}.webp`,
      `kyc/pan/${id}/${id}.jpg`,
    ]) {
      expect(() => {
        assertObjectKey(key);
      }).not.toThrow();
    }
  });

  it('refuses anything that could leave its prefix', () => {
    for (const key of [
      '',
      'file.webp',
      '/etc/passwd',
      'a/../b.webp',
      'a/..',
      'a//b.webp',
      'a/b.webp/',
      'a\\b.webp',
      'a/.hidden',
      'a/b c.webp',
      'a/b?x=1',
    ]) {
      expect(() => {
        assertObjectKey(key);
      }).toThrow(InvalidObjectKeyError);
    }
  });
});

describe('LocalObjectStore', () => {
  let dir: string;
  let store: LocalObjectStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'object-store-test-'));
    store = new LocalObjectStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts, gets and deletes; a missing object is null, and deleting it again is fine', async () => {
    await store.put('area/a/file.webp', WEBP, { contentType: 'image/webp' });

    await expect(store.get('area/a/file.webp')).resolves.toEqual(WEBP);
    await expect(readFile(join(dir, 'area', 'a', 'file.webp'))).resolves.toEqual(WEBP);
    await store.delete('area/a/file.webp');
    await store.delete('area/a/file.webp');
    await expect(store.get('area/a/file.webp')).resolves.toBeNull();
  });

  it('never overwrites an object', async () => {
    await store.put('area/file.webp', WEBP, { contentType: 'image/webp' });

    await expect(
      store.put('area/file.webp', Buffer.from('other'), { contentType: 'image/webp' }),
    ).rejects.toThrow();
    await expect(store.get('area/file.webp')).resolves.toEqual(WEBP);
  });

  it('refuses a key outside the root before touching the disk', async () => {
    await writeFile(join(dir, 'secret.txt'), 'keep');

    await expect(store.get('area/../secret.txt')).rejects.toThrow(InvalidObjectKeyError);
    await expect(store.delete('area/../secret.txt')).rejects.toThrow(InvalidObjectKeyError);
    await expect(readFile(join(dir, 'secret.txt'), 'utf8')).resolves.toBe('keep');
  });
});

describe('S3ObjectStore', () => {
  let s3: FakeS3;
  let store: S3ObjectStore;

  beforeEach(() => {
    s3 = new FakeS3();
    store = new S3ObjectStore(s3, PUBLIC);
  });

  it('sends one PutObject with the bytes, their length, type and cache policy', async () => {
    await store.put('promotions/a.webp', WEBP, {
      contentType: 'image/webp',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    });

    expect(s3.log).toEqual([{ operation: 'PutObject', bucket: PUBLIC, key: 'promotions/a.webp' }]);
    expect(s3.objects.get(`${PUBLIC}/promotions/a.webp`)).toEqual({
      body: WEBP,
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
    });
  });

  it('reads an object back, and answers null for a key that is not there', async () => {
    await store.put('promotions/a.webp', WEBP, { contentType: 'image/webp' });

    await expect(store.get('promotions/a.webp')).resolves.toEqual(WEBP);
    await expect(store.get('promotions/missing.webp')).resolves.toBeNull();
  });

  it('deletes with DeleteObject, also when the object is already gone', async () => {
    await store.put('promotions/a.webp', WEBP, { contentType: 'image/webp' });

    await store.delete('promotions/a.webp');
    await store.delete('promotions/a.webp');

    expect(s3.keys(PUBLIC)).toEqual([]);
    expect(s3.log.filter((entry) => entry.operation === 'DeleteObject')).toHaveLength(2);
  });

  it('passes a service failure on (the caller decides what it means)', async () => {
    s3.failing.add('PutObject').add('DeleteObject').add('GetObject');

    await expect(store.put('a/b.webp', WEBP, { contentType: 'image/webp' })).rejects.toThrow();
    await expect(store.delete('a/b.webp')).rejects.toThrow();
    await expect(store.get('a/b.webp')).rejects.toThrow();
  });

  it('sends nothing for a key it would not have generated', async () => {
    await expect(store.delete('../other-bucket/x')).rejects.toThrow(InvalidObjectKeyError);
    expect(s3.log).toEqual([]);
  });
});

describe('file storage on S3', () => {
  const orderId = randomUUID();
  const productId = randomUUID();
  const vendorId = randomUUID();
  let s3: FakeS3;
  let storage: ReturnType<typeof s3FileStorage>;

  beforeEach(() => {
    s3 = new FakeS3();
    storage = s3FileStorage(s3, {
      publicBucket: PUBLIC,
      privateBucket: PRIVATE,
      publicBaseUrl: `${CDN}/`,
    });
  });

  it('puts public files in the public bucket under their area, read from the CDN', async () => {
    const evidence = await storage.evidence.save(orderId, WEBP, 'image/webp');
    const photo = await storage.productImages.save(productId, WEBP, 'image/webp');
    const banner = await storage.promotionImages.save(WEBP, 'image/webp');

    expect(evidence.url).toMatch(
      new RegExp(`^${CDN}/dispute-evidence/${orderId}/[0-9a-f-]{36}\\.webp$`),
    );
    expect(photo).toMatch(new RegExp(`^${CDN}/product-images/${productId}/[0-9a-f-]{36}\\.webp$`));
    expect(banner).toMatch(new RegExp(`^${CDN}/promotions/[0-9a-f-]{36}\\.webp$`));
    expect(s3.keys(PUBLIC)).toEqual(
      [evidence.url, photo, banner].map((url) => url.slice(CDN.length + 1)).sort(),
    );
    expect(s3.keys(PRIVATE)).toEqual([]);
    for (const object of s3.objects.values()) {
      expect(object).toMatchObject({
        contentType: 'image/webp',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      });
    }
  });

  it('puts a KYC document in the private bucket only, and hands back a key, not a URL', async () => {
    const key = await storage.kycDocuments.savePanDocument(vendorId, WEBP, 'image/webp');

    expect(key).toMatch(new RegExp(`^kyc/pan/${vendorId}/[0-9a-f-]{36}\\.webp$`));
    expect(key).not.toContain('http');
    expect(s3.keys(PRIVATE)).toEqual([key]);
    expect(s3.keys(PUBLIC)).toEqual([]);
    expect(s3.objects.get(`${PRIVATE}/${key}`)?.cacheControl).toBe('private, no-store');
    await expect(storage.kycDocuments.read(key)).resolves.toEqual({
      bytes: WEBP,
      contentType: 'image/webp',
    });
  });

  it('deleteFile(url) removes the object behind a URL it issued, once and again', async () => {
    const photo = await storage.productImages.save(productId, WEBP, 'image/webp');
    const banner = await storage.promotionImages.save(WEBP, 'image/webp');
    const { url: evidence } = await storage.evidence.save(orderId, WEBP, 'image/webp');

    await expect(storage.productImages.deleteFile(photo)).resolves.toBe(true);
    await expect(storage.productImages.deleteFile(photo)).resolves.toBe(true);
    await expect(storage.promotionImages.deleteFile(banner)).resolves.toBe(true);
    await expect(storage.evidence.deleteFile(evidence)).resolves.toBe(true);

    expect(s3.keys(PUBLIC)).toEqual([]);
  });

  it('deleteFile never deletes through a URL the storage did not issue', async () => {
    const photo = await storage.productImages.save(productId, WEBP, 'image/webp');
    const banner = await storage.promotionImages.save(WEBP, 'image/webp');
    const key = await storage.kycDocuments.savePanDocument(vendorId, WEBP, 'image/webp');
    const name = photo.split('/').at(-1) ?? '';
    const before = s3.log.length;

    const refused = [
      await storage.productImages.deleteFile('https://elsewhere.test/product-images/x.webp'),
      await storage.productImages.deleteFile(banner),
      await storage.productImages.deleteFile(`${CDN}/product-images/${productId}/../${name}`),
      await storage.productImages.deleteFile(`${CDN}/product-images/${productId}/${name}?x=1`),
      await storage.productImages.deleteFile(`${CDN}/product-images/${productId}/notes.txt`),
      await storage.promotionImages.deleteFile(photo),
      await storage.promotionImages.deleteFile(`${CDN}/promotions/${productId}/${name}`),
      await storage.promotionImages.deleteFile(`${CDN}/${key}`),
      await storage.evidence.deleteFile(photo),
      await storage.kycDocuments.deleteFile(photo),
      await storage.kycDocuments.deleteFile(`kyc/pan/${vendorId}/../../${name}`),
      await storage.kycDocuments.deleteFile(`product-images/${productId}/${name}`),
    ];

    expect(refused).toEqual(refused.map(() => false));
    expect(s3.log).toHaveLength(before);
    expect(s3.keys(PUBLIC)).toHaveLength(2);
    expect(s3.keys(PRIVATE)).toEqual([key]);
  });

  it('remove(productId, url) only touches that product’s photos', async () => {
    const other = randomUUID();
    const mine = await storage.productImages.save(productId, WEBP, 'image/webp');
    const theirs = await storage.productImages.save(other, WEBP, 'image/webp');

    await storage.productImages.remove(productId, theirs);
    expect(s3.keys(PUBLIC)).toHaveLength(2);

    await storage.productImages.remove(productId, mine);
    expect(s3.keys(PUBLIC)).toEqual([theirs.slice(CDN.length + 1)]);
  });

  it('owns() tells an uploaded promotion image from a pasted URL', async () => {
    const banner = await storage.promotionImages.save(WEBP, 'image/webp');

    expect(storage.promotionImages.owns(banner)).toBe(true);
    expect(storage.promotionImages.owns('https://picsum.photos/seed/x/800/400')).toBe(false);
    expect(
      storage.promotionImages.owns(`${CDN}/product-images/${productId}/${randomUUID()}.webp`),
    ).toBe(false);
  });

  it('reads nothing through a key that is not a KYC document', async () => {
    const photo = await storage.productImages.save(productId, WEBP, 'image/webp');
    const before = s3.log.length;

    await expect(storage.kycDocuments.read(photo.slice(CDN.length + 1))).resolves.toBeNull();
    await expect(
      storage.kycDocuments.read(`kyc/pan/${vendorId}/${randomUUID()}.webp`),
    ).resolves.toBeNull();
    expect(s3.log.slice(before).map((entry) => entry.bucket)).toEqual([PRIVATE]);
  });
});

describe('local file storage', () => {
  let publicDir: string;
  let privateDir: string;

  beforeEach(async () => {
    publicDir = await mkdtemp(join(tmpdir(), 'uploads-public-'));
    privateDir = await mkdtemp(join(tmpdir(), 'uploads-private-'));
  });
  afterEach(async () => {
    await rm(publicDir, { recursive: true, force: true });
    await rm(privateDir, { recursive: true, force: true });
  });

  it('keeps KYC documents outside the directory the API serves', async () => {
    const storage = localFileStorage(publicDir, privateDir, 'http://localhost:4000/uploads');
    const vendorId = randomUUID();

    const key = await storage.kycDocuments.savePanDocument(vendorId, WEBP, 'image/webp');
    await storage.promotionImages.save(WEBP, 'image/webp');

    expect(await readdir(publicDir)).toEqual(['promotions']);
    expect(await readdir(join(privateDir, 'kyc', 'pan', vendorId))).toEqual([
      key.split('/').at(-1),
    ]);
    expect(storage.evidence).toBeInstanceOf(LocalEvidenceStorage);
  });
});

describe('fileStorageFromEnv', () => {
  const base = {
    COUNTRY_CODE: 'NP',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    KAFKA_BROKERS: '127.0.0.1:9092',
    KAFKA_CLIENT_ID: 'c',
    KAFKA_CONSUMER_GROUP_ID: 'g',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    ESEWA_PRODUCT_CODE: 'EPAYTEST',
    ESEWA_SECRET_KEY: 'esewa-secret',
    ESEWA_PAYMENT_URL: 'https://esewa.test/pay',
    ESEWA_STATUS_CHECK_URL: 'https://esewa.test/status',
    ESEWA_SUCCESS_URL: 'https://app.test/ok',
    ESEWA_FAILURE_URL: 'https://app.test/fail',
    KHALTI_SECRET_KEY: 'khalti-secret',
    KHALTI_BASE_URL: 'https://khalti.test/api',
    KHALTI_RETURN_URL: 'https://app.test/return',
    KHALTI_WEBSITE_URL: 'https://app.test',
    SMS_PROVIDER: 'MOCK',
  };
  const s3 = {
    STORAGE_DRIVER: 'S3',
    S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    S3_ACCESS_KEY_ID: 'key-id',
    S3_SECRET_ACCESS_KEY: 'key-secret',
    S3_PUBLIC_BUCKET: PUBLIC,
    S3_PRIVATE_BUCKET: PRIVATE,
    S3_PUBLIC_BASE_URL: CDN,
  };
  const defaults = { publicDir: '/srv/uploads', privateDir: '/srv/uploads-private' };

  it('is the local disk by default', () => {
    const storage = fileStorageFromEnv(parseServerEnv(base), defaults);

    expect(storage.evidence).toBeInstanceOf(LocalEvidenceStorage);
    expect((storage.evidence as LocalEvidenceStorage).rootDir).toBe('/srv/uploads');
    expect((storage.evidence as LocalEvidenceStorage).publicBaseUrl).toBe(
      'http://localhost:4000/uploads',
    );
  });

  it('is the buckets with STORAGE_DRIVER=S3: nothing for the API to serve', () => {
    const storage = fileStorageFromEnv(parseServerEnv({ ...base, ...s3 }), defaults);

    expect(storage.evidence).toBeInstanceOf(ObjectEvidenceStorage);
    expect(storage.evidence).not.toBeInstanceOf(LocalEvidenceStorage);
    expect(storage.productImages).toBeInstanceOf(ObjectProductImageStorage);
    expect((storage.productImages as ObjectProductImageStorage).publicBaseUrl).toBe(CDN);
  });

  it('refuses an incomplete or unsafe S3 configuration at startup', () => {
    const { S3_PUBLIC_BASE_URL: _url, ...withoutUrl } = s3;
    const { S3_SECRET_ACCESS_KEY: _secret, ...halfCredentials } = s3;

    expect(() => parseServerEnv({ ...base, ...withoutUrl })).toThrow(/S3_PUBLIC_BASE_URL/);
    expect(() => parseServerEnv({ ...base, ...halfCredentials })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => parseServerEnv({ ...base, ...s3, S3_PRIVATE_BUCKET: PUBLIC })).toThrow(
      /their own bucket/,
    );
  });

  it('refuses the local disk, and a plain-http CDN, in production', () => {
    const production = {
      ...base,
      NODE_ENV: 'production',
      SMS_PROVIDER: 'AAKASH',
      AAKASH_SMS_AUTH_TOKEN: 't',
      AAKASH_SMS_API_URL: 'https://sms.test',
      // Phase 7: the other keys a production server must have (server-env.test.ts).
      VENDOR_CREDENTIALS_KEY: 'A'.repeat(43) + '=',
      PUBLIC_API_BASE_URL: 'https://api.hamropasal.test',
      ESEWA_SUCCESS_URL: 'https://api.hamropasal.test/payments/esewa/success',
      ESEWA_FAILURE_URL: 'https://api.hamropasal.test/payments/esewa/failure',
      KHALTI_RETURN_URL: 'https://api.hamropasal.test/payments/khalti/return',
      KHALTI_WEBSITE_URL: 'https://hamropasal.test',
    };

    expect(() => parseServerEnv(production)).toThrow(/STORAGE_DRIVER/);
    expect(() =>
      parseServerEnv({ ...production, ...s3, S3_PUBLIC_BASE_URL: 'http://cdn.hamropasal.test' }),
    ).toThrow(/https/);
    expect(parseServerEnv({ ...production, ...s3 }).STORAGE_DRIVER).toBe('S3');
  });

  it('works with an instance role: no keys at all', () => {
    const {
      S3_ACCESS_KEY_ID: _id,
      S3_SECRET_ACCESS_KEY: _secret,
      S3_ENDPOINT: _endpoint,
      ...role
    } = s3;

    expect(() => fileStorageFromEnv(parseServerEnv({ ...base, ...role }), defaults)).not.toThrow();
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalEvidenceStorage, sniffEvidenceType } from './evidence-storage';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

describe('sniffEvidenceType', () => {
  it('recognises JPEG, PNG and WebP by their bytes', () => {
    expect(sniffEvidenceType(JPEG)).toBe('image/jpeg');
    expect(sniffEvidenceType(PNG)).toBe('image/png');
    expect(sniffEvidenceType(WEBP)).toBe('image/webp');
  });

  it('refuses anything else, whatever it is called', () => {
    expect(sniffEvidenceType(Buffer.from('%PDF-1.7'))).toBeNull();
    expect(sniffEvidenceType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffEvidenceType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffEvidenceType(Buffer.alloc(0))).toBeNull();
  });
});

describe('LocalEvidenceStorage', () => {
  const orderId = randomUUID();
  let dir: string;
  let storage: LocalEvidenceStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'evidence-test-'));
    storage = new LocalEvidenceStorage(dir, 'http://localhost:4000/uploads/');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the file under the order and returns its public URL', async () => {
    const stored = await storage.save(orderId, JPEG, 'image/jpeg');

    const prefix = `http://localhost:4000/uploads/dispute-evidence/${orderId}/`;
    expect(stored.contentType).toBe('image/jpeg');
    expect(stored.url.startsWith(prefix)).toBe(true);
    const name = stored.url.slice(prefix.length);
    expect(name).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    await expect(readFile(join(dir, 'dispute-evidence', orderId, name))).resolves.toEqual(JPEG);
  });

  it('serves under the base URL path', () => {
    expect(storage.mountPath).toBe('/uploads');
    expect(new LocalEvidenceStorage(dir, 'http://192.168.1.20:4000').mountPath).toBe('/');
  });

  it('recognises only URLs it issued for that order', async () => {
    const { url } = await storage.save(orderId, PNG, 'image/png');

    expect(storage.isEvidenceUrl(orderId, url)).toBe(true);
    expect(storage.isEvidenceUrl(randomUUID(), url)).toBe(false);
    expect(storage.isEvidenceUrl(orderId, 'https://tracker.example/pixel.png')).toBe(false);
    expect(
      storage.isEvidenceUrl(
        orderId,
        `http://localhost:4000/uploads/dispute-evidence/${orderId}/../../secrets.png`,
      ),
    ).toBe(false);
  });
});

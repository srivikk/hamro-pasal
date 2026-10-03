import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalProductImageStorage } from './product-image-storage';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('LocalProductImageStorage', () => {
  const productId = randomUUID();
  let dir: string;
  let storage: LocalProductImageStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'product-images-test-'));
    storage = new LocalProductImageStorage(dir, 'http://localhost:4000/uploads/');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const filesOf = (id: string) => readdir(join(dir, 'product-images', id));

  it('writes the file under the product and returns its public URL', async () => {
    const url = await storage.save(productId, PNG, 'image/png');

    const prefix = `http://localhost:4000/uploads/product-images/${productId}/`;
    expect(url.startsWith(prefix)).toBe(true);
    const name = url.slice(prefix.length);
    expect(name).toMatch(/^[0-9a-f-]{36}\.png$/);
    await expect(readFile(join(dir, 'product-images', productId, name))).resolves.toEqual(PNG);
  });

  it('gives every photo its own name', async () => {
    const urls = await Promise.all([
      storage.save(productId, PNG, 'image/png'),
      storage.save(productId, PNG, 'image/png'),
    ]);

    expect(new Set(urls).size).toBe(2);
    expect(await filesOf(productId)).toHaveLength(2);
  });

  it('serves under the base URL path', () => {
    expect(storage.mountPath).toBe('/uploads');
    expect(new LocalProductImageStorage(dir, 'http://192.168.1.20:4000').mountPath).toBe('/');
  });

  it('removes a photo it issued, and tolerates one that is already gone', async () => {
    const url = await storage.save(productId, PNG, 'image/png');

    await storage.remove(productId, url);
    await storage.remove(productId, url);

    expect(await filesOf(productId)).toEqual([]);
  });

  it('never deletes through a URL it did not issue for that product', async () => {
    const other = randomUUID();
    const mine = await storage.save(productId, PNG, 'image/png');
    const theirs = await storage.save(other, PNG, 'image/png');
    await writeFile(join(dir, 'secret.txt'), 'keep');
    const prefix = `http://localhost:4000/uploads/product-images/${productId}/`;

    await storage.remove(productId, theirs);
    await storage.remove(productId, 'https://cdn.hamropasal.test/p/tea.webp');
    await storage.remove(productId, `${prefix}../../secret.txt`);
    await storage.remove(productId, `${prefix}../${other}/${theirs.split('/').at(-1) ?? ''}`);

    expect(await filesOf(productId)).toHaveLength(1);
    expect(await filesOf(other)).toHaveLength(1);
    await expect(readFile(join(dir, 'secret.txt'), 'utf8')).resolves.toBe('keep');
    expect(mine).toContain(productId);
  });
});

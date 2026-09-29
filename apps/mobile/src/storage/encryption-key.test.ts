import { getOrCreateStorageKey, STORAGE_KEY_LENGTH, type KeyVault } from './encryption-key';

function memoryVault(initial?: string): KeyVault & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set('vault-key', initial);
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

const sequentialBytes = (count: number): Uint8Array =>
  Uint8Array.from({ length: count }, (_, i) => i * 7);

describe('getOrCreateStorageKey', () => {
  it('generates a 32-byte key on first launch and stores it in the vault', () => {
    const vault = memoryVault();

    const key = getOrCreateStorageKey(vault, 'vault-key', sequentialBytes);

    expect(key).toHaveLength(STORAGE_KEY_LENGTH);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(vault.entries.get('vault-key')).toBe(key);
  });

  it('reuses the stored key on later launches without drawing new randomness', () => {
    const existing = 'k'.repeat(STORAGE_KEY_LENGTH);
    const randomBytes = jest.fn(sequentialBytes);

    expect(getOrCreateStorageKey(memoryVault(existing), 'vault-key', randomBytes)).toBe(existing);
    expect(randomBytes).not.toHaveBeenCalled();
  });

  it('replaces a malformed stored key', () => {
    const vault = memoryVault('too-short');

    const key = getOrCreateStorageKey(vault, 'vault-key', sequentialBytes);

    expect(key).toHaveLength(STORAGE_KEY_LENGTH);
    expect(vault.entries.get('vault-key')).toBe(key);
  });

  it('maps every byte value into the alphabet (no out-of-range characters)', () => {
    const allBytes = (count: number): Uint8Array =>
      Uint8Array.from({ length: count }, (_, i) => 255 - i);

    expect(getOrCreateStorageKey(memoryVault(), 'vault-key', allBytes)).toMatch(
      /^[A-Za-z0-9_-]{32}$/,
    );
  });

  it('refuses to create a key from the wrong amount of randomness', () => {
    const vault = memoryVault();

    expect(() => getOrCreateStorageKey(vault, 'vault-key', () => new Uint8Array(16))).toThrow(
      'Expected 32 random bytes, got 16',
    );
    expect(vault.entries.size).toBe(0);
  });
});

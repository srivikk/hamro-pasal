/** 32 ASCII characters = 32 bytes, the AES-256 key length MMKV accepts. */
export const STORAGE_KEY_LENGTH = 32;

const KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Synchronous keychain operations (expo-secure-store's `getItem` / `setItem`). */
export interface KeyVault {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Returns the MMKV encryption key held in the OS keychain (iOS Keychain / Android Keystore),
 * generating and storing it on first launch. SPEC implicit requirement 3 allows MMKV persistence
 * only with encryption keys, and the key must never live next to the data it protects.
 *
 * The alphabet has 64 symbols, so `byte & 63` maps each random byte without modulo bias
 * (192 bits of entropy in total).
 */
export function getOrCreateStorageKey(
  vault: KeyVault,
  vaultKey: string,
  randomBytes: (byteCount: number) => Uint8Array,
): string {
  const existing = vault.getItem(vaultKey);
  if (existing !== null && existing.length === STORAGE_KEY_LENGTH) return existing;

  const bytes = randomBytes(STORAGE_KEY_LENGTH);
  if (bytes.length !== STORAGE_KEY_LENGTH) {
    throw new Error(
      `Expected ${String(STORAGE_KEY_LENGTH)} random bytes, got ${String(bytes.length)}`,
    );
  }
  const key = Array.from(bytes, (byte) => KEY_ALPHABET.charAt(byte & 63)).join('');
  vault.setItem(vaultKey, key);
  return key;
}

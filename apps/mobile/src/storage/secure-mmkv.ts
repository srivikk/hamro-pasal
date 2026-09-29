import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { createMMKV, type MMKV } from 'react-native-mmkv';

import { getOrCreateStorageKey } from './encryption-key';

const SECURE_STORAGE_ID = 'hamro-pasal.secure';
export const ENCRYPTION_KEY_VAULT_ENTRY = 'hamro-pasal.mmkv-key';

/** Keychain entry readable after the first unlock (background token refresh), never synced off-device. */
const vaultOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** AES-256 encrypted MMKV instance for session data. Created once, on first use. */
let instance: MMKV | undefined;

export function getSecureStorage(): MMKV {
  instance ??= createMMKV({
    id: SECURE_STORAGE_ID,
    encryptionKey: getOrCreateStorageKey(
      {
        getItem: (key) => SecureStore.getItem(key, vaultOptions),
        setItem: (key, value) => {
          SecureStore.setItem(key, value, vaultOptions);
        },
      },
      ENCRYPTION_KEY_VAULT_ENTRY,
      getRandomBytes,
    ),
    encryptionType: 'AES-256',
  });
  return instance;
}

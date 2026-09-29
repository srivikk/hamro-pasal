import { createMMKV, type MMKV } from 'react-native-mmkv';

const APP_STORAGE_ID = 'hamro-pasal.app';

/**
 * Unencrypted MMKV instance for non-sensitive client state (cart contents). Credentials never go
 * here: they belong in the encrypted instance from `secure-mmkv.ts`.
 */
let instance: MMKV | undefined;

export function getAppStorage(): MMKV {
  instance ??= createMMKV({ id: APP_STORAGE_ID });
  return instance;
}

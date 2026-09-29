import type * as InMemoryMmkvModule from './src/test/in-memory-mmkv';

// react-native-mmkv v4 loads its native NitroModules at import time, which do not exist under
// Jest. Every MMKV instance becomes a synchronous in-memory map instead.
jest.mock('react-native-mmkv', () => {
  const { InMemoryMmkv } = jest.requireActual<typeof InMemoryMmkvModule>(
    './src/test/in-memory-mmkv',
  );
  return { createMMKV: () => new InMemoryMmkv() };
});

// Native keychain and CSPRNG stand-ins with the same synchronous API, backed by Node.
jest.mock('expo-secure-store', () => {
  const entries = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
});

jest.mock('expo-crypto', () => {
  // Typed structurally: the app's tsconfig does not load Node's type definitions.
  const nodeCrypto = jest.requireActual<{
    randomUUID: () => string;
    randomBytes: (count: number) => Uint8Array;
  }>('node:crypto');
  return {
    randomUUID: () => nodeCrypto.randomUUID(),
    getRandomBytes: (count: number) => new Uint8Array(nodeCrypto.randomBytes(count)),
  };
});

// API base URL for modules that import src/config/api. Tests that exercise the missing-variable
// startup error delete it explicitly.
process.env.EXPO_PUBLIC_API_URL ??= 'http://api.hamropasal.test';

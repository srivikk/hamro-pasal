import type * as InMemoryMmkvModule from './src/test/in-memory-mmkv';

// react-native-mmkv v4 loads its native NitroModules at import time, which do not exist under
// Jest. Every MMKV instance becomes a synchronous in-memory map instead.
jest.mock('react-native-mmkv', () => {
  const { InMemoryMmkv } = jest.requireActual<typeof InMemoryMmkvModule>(
    './src/test/in-memory-mmkv',
  );
  return { createMMKV: () => new InMemoryMmkv() };
});

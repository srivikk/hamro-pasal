import type * as ReactModule from 'react';
import type * as ReactNativeModule from 'react-native';

import type * as InMemoryMmkvModule from './src/test/in-memory-mmkv';

// react-native-mmkv v4 loads its native NitroModules at import time, which do not exist under
// Jest. Every MMKV instance becomes a synchronous in-memory map instead.
jest.mock('react-native-mmkv', () => {
  const { InMemoryMmkv } = jest.requireActual<typeof InMemoryMmkvModule>(
    './src/test/in-memory-mmkv',
  );
  return { createMMKV: () => new InMemoryMmkv() };
});

// Reanimated's worklet runtime is native. Both libraries ship Jest mocks (worklets first: the
// Reanimated mock imports it); animations then run synchronously.
jest.mock('react-native-worklets', () =>
  jest.requireActual<Record<string, unknown>>('react-native-worklets/src/mock'),
);
jest.mock('react-native-reanimated', () =>
  jest.requireActual<Record<string, unknown>>('react-native-reanimated/mock'),
);

// WebView is a native view. The stand-in records its props so tests can drive navigation
// (src/test/mock-webview.tsx); it is loaded lazily, when a test first imports the WebView.
jest.mock('react-native-webview', () =>
  jest.requireActual<Record<string, unknown>>('./src/test/mock-webview'),
);

// expo-audio's player is native. The stand-in records every player and playback call
// (src/test/fake-audio.ts), so the vendor alarm tests can assert play / pause / seekTo.
jest.mock('expo-audio', () => jest.requireActual<Record<string, unknown>>('./src/test/fake-audio'));

// expo-notifications and expo-task-manager are native. One stand-in (src/test/fake-notifications.ts)
// answers permission, token, channel, handler and task calls and records them.
jest.mock('expo-notifications', () =>
  jest.requireActual<Record<string, unknown>>('./src/test/fake-notifications'),
);
jest.mock('expo-task-manager', () =>
  jest.requireActual<Record<string, unknown>>('./src/test/fake-notifications'),
);

// Icon fonts load asynchronously and re-render the icon when ready, outside any test's act().
// A plain view keeps renders deterministic; no test depends on the glyph.
jest.mock('@expo/vector-icons/Ionicons', () => {
  const { createElement } = jest.requireActual<typeof ReactModule>('react');
  const { View } = jest.requireActual<typeof ReactNativeModule>('react-native');
  return {
    __esModule: true,
    default: ({ name }: { name: string }) => createElement(View, { testID: `icon-${name}` }),
  };
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

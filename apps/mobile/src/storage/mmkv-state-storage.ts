import type { MMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/** The subset of MMKV that Zustand persistence needs, so tests can supply an in-memory engine. */
export type MmkvEngine = Pick<MMKV, 'getString' | 'set' | 'remove'>;

/**
 * Adapts an MMKV instance to Zustand's `StateStorage`. MMKV is synchronous, so the persisted store
 * hydrates during `create()`, before the first render, and never renders a signed-out flash.
 */
export function mmkvStateStorage(engine: MmkvEngine): StateStorage<void> {
  return {
    getItem: (name) => engine.getString(name) ?? null,
    setItem: (name, value) => {
      engine.set(name, value);
    },
    removeItem: (name) => {
      engine.remove(name);
    },
  };
}

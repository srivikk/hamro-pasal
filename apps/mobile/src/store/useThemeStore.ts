import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const THEME_STORE_KEY = 'hamro-pasal.theme';
export const THEME_STORE_VERSION = 1;

/** `system` follows the phone's light / dark setting. */
export const APP_THEMES = ['system', 'light', 'dark'] as const;
export type AppTheme = (typeof APP_THEMES)[number];
export const DEFAULT_THEME: AppTheme = 'system';

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEMES as readonly string[]).includes(value);
}

export interface ThemeState {
  /** A device preference, not an account one: kept across sign-out, never sent to the server. */
  theme: AppTheme;
  setTheme: (theme: AppTheme) => void;
}

export type PersistedThemeState = Pick<ThemeState, 'theme'>;

export type ThemeStore = UseBoundStore<
  Mutate<StoreApi<ThemeState>, [['zustand/persist', PersistedThemeState]]>
>;

function toPersistedTheme(value: unknown): PersistedThemeState {
  const theme: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'theme') : null;
  return { theme: isAppTheme(theme) ? theme : DEFAULT_THEME };
}

export function createThemeStore(storage: StateStorage<void>): ThemeStore {
  return create<ThemeState>()(
    persist<ThemeState, [], [], PersistedThemeState>(
      (set) => ({
        theme: DEFAULT_THEME,
        setTheme: (theme) => {
          set({ theme });
        },
      }),
      {
        name: THEME_STORE_KEY,
        version: THEME_STORE_VERSION,
        storage: createJSONStorage<PersistedThemeState>(() => storage),
        partialize: ({ theme }): PersistedThemeState => ({ theme }),
        migrate: (persisted) => toPersistedTheme(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedTheme(persisted) }),
      },
    ),
  );
}

export const useThemeStore: ThemeStore = createThemeStore(mmkvStateStorage(getAppStorage()));

import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from '../i18n/app-locale';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';

export const AUTH_STORE_KEY = 'hamro-pasal.auth';
export const AUTH_STORE_VERSION = 1;

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
}

export interface AuthState {
  /** 15-minute access JWT. Memory only: SPEC forbids persisting it, so it is excluded from `partialize`. */
  accessToken: string | null;
  /** 7-day refresh JWT. Persisted, in the AES-256 encrypted MMKV instance only. */
  refreshToken: string | null;
  locale: AppLocale;
  setSession: (session: AuthSession) => void;
  setAccessToken: (accessToken: string) => void;
  clearSession: () => void;
  setLocale: (locale: AppLocale) => void;
}

/** The slice written to disk. Anything not listed here never leaves memory. */
export type PersistedAuthState = Pick<AuthState, 'refreshToken' | 'locale'>;

export type AuthStore = UseBoundStore<
  Mutate<StoreApi<AuthState>, [['zustand/persist', PersistedAuthState]]>
>;

/**
 * Anything on disk that is not a valid persisted slice (tampered, or written by a future schema)
 * is discarded rather than trusted, so the user simply signs in again.
 */
function toPersistedAuthState(value: unknown): PersistedAuthState {
  if (typeof value !== 'object' || value === null) {
    return { refreshToken: null, locale: DEFAULT_LOCALE };
  }
  const refreshToken: unknown = Reflect.get(value, 'refreshToken');
  const locale: unknown = Reflect.get(value, 'locale');
  return {
    refreshToken: typeof refreshToken === 'string' && refreshToken !== '' ? refreshToken : null,
    locale: isAppLocale(locale) ? locale : DEFAULT_LOCALE,
  };
}

export function createAuthStore(storage: StateStorage<void>): AuthStore {
  return create<AuthState>()(
    persist<AuthState, [], [], PersistedAuthState>(
      (set) => ({
        accessToken: null,
        refreshToken: null,
        locale: DEFAULT_LOCALE,
        setSession: ({ accessToken, refreshToken }) => {
          set({ accessToken, refreshToken });
        },
        setAccessToken: (accessToken) => {
          set({ accessToken });
        },
        clearSession: () => {
          set({ accessToken: null, refreshToken: null });
        },
        setLocale: (locale) => {
          set({ locale });
        },
      }),
      {
        name: AUTH_STORE_KEY,
        version: AUTH_STORE_VERSION,
        storage: createJSONStorage<PersistedAuthState>(() => storage),
        partialize: ({ refreshToken, locale }): PersistedAuthState => ({ refreshToken, locale }),
        migrate: (persisted) => toPersistedAuthState(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedAuthState(persisted) }),
      },
    ),
  );
}

export const useAuthStore: AuthStore = createAuthStore(mmkvStateStorage(getSecureStorage()));

/**
 * Signed in: an access token in memory, or a refresh token in encrypted storage that apiRequest
 * can exchange for one (after a relaunch the access token is gone but the session is not).
 */
export function selectHasSession(state: Pick<AuthState, 'accessToken' | 'refreshToken'>): boolean {
  return state.accessToken !== null || state.refreshToken !== null;
}

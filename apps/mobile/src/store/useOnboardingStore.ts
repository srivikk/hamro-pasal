import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const ONBOARDING_STORE_KEY = 'hamro-pasal.onboarding';
/** v2 added `languageChosen`; a v1 slice migrates as "not chosen yet" (asked once). */
export const ONBOARDING_STORE_VERSION = 2;

export interface OnboardingState {
  /**
   * The visitor pressed "Skip login" on the welcome screen and browses as a guest. Persisted, so
   * a guest is not asked again on every launch; signing in makes it irrelevant, and it is reset
   * with the rest of the local data (SPEC §1 purge).
   */
  authWallSkipped: boolean;
  /**
   * The visitor answered the first-launch language question (English / Nepali). Persisted, so it
   * is asked once per installation. The language itself is `useAuthStore.locale`.
   */
  languageChosen: boolean;
  skipAuthWall: () => void;
  markLanguageChosen: () => void;
  /** Asks for sign-in again. The language answer is kept. */
  resetOnboarding: () => void;
}

export type PersistedOnboardingState = Pick<OnboardingState, 'authWallSkipped' | 'languageChosen'>;

export type OnboardingStore = UseBoundStore<
  Mutate<StoreApi<OnboardingState>, [['zustand/persist', PersistedOnboardingState]]>
>;

function toPersistedOnboarding(value: unknown): PersistedOnboardingState {
  if (typeof value !== 'object' || value === null) {
    return { authWallSkipped: false, languageChosen: false };
  }
  return {
    authWallSkipped: Reflect.get(value, 'authWallSkipped') === true,
    languageChosen: Reflect.get(value, 'languageChosen') === true,
  };
}

export function createOnboardingStore(storage: StateStorage<void>): OnboardingStore {
  return create<OnboardingState>()(
    persist<OnboardingState, [], [], PersistedOnboardingState>(
      (set) => ({
        authWallSkipped: false,
        languageChosen: false,
        skipAuthWall: () => {
          set({ authWallSkipped: true });
        },
        markLanguageChosen: () => {
          set({ languageChosen: true });
        },
        resetOnboarding: () => {
          set({ authWallSkipped: false });
        },
      }),
      {
        name: ONBOARDING_STORE_KEY,
        version: ONBOARDING_STORE_VERSION,
        storage: createJSONStorage<PersistedOnboardingState>(() => storage),
        partialize: ({ authWallSkipped, languageChosen }): PersistedOnboardingState => ({
          authWallSkipped,
          languageChosen,
        }),
        migrate: (persisted) => toPersistedOnboarding(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedOnboarding(persisted) }),
      },
    ),
  );
}

export const useOnboardingStore: OnboardingStore = createOnboardingStore(
  mmkvStateStorage(getAppStorage()),
);

import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const DISMISSED_TUTORIALS_STORE_KEY = 'hamro-pasal.dismissed-tutorials';

/**
 * Step 7.8: the tutorial videos this phone said "Don't show again" to, by YouTube video id. Kept in
 * MMKV, so a dismissed card stays dismissed across launches; a new video shows its card.
 */
export interface DismissedTutorialsState {
  dismissed: Record<string, true>;
  dismiss: (videoId: string) => void;
}

type Persisted = Pick<DismissedTutorialsState, 'dismissed'>;

export type DismissedTutorialsStore = UseBoundStore<
  Mutate<StoreApi<DismissedTutorialsState>, [['zustand/persist', Persisted]]>
>;

function toPersisted(value: unknown): Persisted {
  const dismissed: Record<string, true> = {};
  const raw: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'dismissed') : undefined;
  if (typeof raw === 'object' && raw !== null) {
    for (const [id, flag] of Object.entries(raw)) {
      if (flag === true && /^[A-Za-z0-9_-]{11}$/.test(id)) dismissed[id] = true;
    }
  }
  return { dismissed };
}

export function createDismissedTutorialsStore(
  storage: StateStorage<void>,
): DismissedTutorialsStore {
  return create<DismissedTutorialsState>()(
    persist<DismissedTutorialsState, [], [], Persisted>(
      (set) => ({
        dismissed: {},
        dismiss: (videoId) => {
          set((state) => ({ dismissed: { ...state.dismissed, [videoId]: true } }));
        },
      }),
      {
        name: DISMISSED_TUTORIALS_STORE_KEY,
        version: 1,
        storage: createJSONStorage<Persisted>(() => storage),
        partialize: ({ dismissed }) => ({ dismissed }),
        migrate: (persisted) => toPersisted(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersisted(persisted) }),
      },
    ),
  );
}

export const useDismissedTutorialsStore: DismissedTutorialsStore = createDismissedTutorialsStore(
  mmkvStateStorage(getAppStorage()),
);

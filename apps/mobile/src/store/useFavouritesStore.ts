import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { getAppStorage } from '../storage/app-mmkv';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';

export const FAVOURITES_STORE_KEY = 'hamro-pasal.favourites';
export const FAVOURITES_STORE_VERSION = 1;
export const MAX_FAVOURITES = 100;

/** A saved shop: enough to list it and open it again. */
export interface FavouriteShop {
  vendorId: string;
  name: string;
  /** "Thamel, Kathmandu Metropolitan City", when it was known at the time. */
  location: string | null;
  savedAtMs: number;
}

/**
 * The customer's favourite shops (the heart on a shop's page, the list in Profile).
 *
 * TODO: Replace with the backend favourites (`user_favourites`, STATE_HANDOFF §8Z.8).
 * Kept on this phone only for now: favourites do not follow the account to another device, and a
 * guest's are kept too. When the API exists, this becomes a TanStack query + mutations and the
 * local copy is at most an optimistic cache.
 */
export interface FavouritesState {
  favourites: Record<string, FavouriteShop>;
  /** Saves the shop, or removes it if it is already saved. Returns whether it is saved now. */
  toggleFavourite: (shop: Omit<FavouriteShop, 'savedAtMs'>) => boolean;
  removeFavourite: (vendorId: string) => void;
  resetFavourites: () => void;
}

export type PersistedFavouritesState = Pick<FavouritesState, 'favourites'>;

export type FavouritesStore = UseBoundStore<
  Mutate<StoreApi<FavouritesState>, [['zustand/persist', PersistedFavouritesState]]>
>;

function isFavourite(value: unknown): value is FavouriteShop {
  if (typeof value !== 'object' || value === null) return false;
  const vendorId: unknown = Reflect.get(value, 'vendorId');
  const name: unknown = Reflect.get(value, 'name');
  const location: unknown = Reflect.get(value, 'location');
  const savedAtMs: unknown = Reflect.get(value, 'savedAtMs');
  return (
    typeof vendorId === 'string' &&
    vendorId !== '' &&
    typeof name === 'string' &&
    name !== '' &&
    (location === null || typeof location === 'string') &&
    typeof savedAtMs === 'number' &&
    Number.isFinite(savedAtMs)
  );
}

/** Anything stored that is not a favourite is dropped; the newest MAX_FAVOURITES are kept. */
function toPersistedFavourites(value: unknown): PersistedFavouritesState {
  const stored: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'favourites') : null;
  if (typeof stored !== 'object' || stored === null) return { favourites: {} };
  const kept = Object.values(stored)
    .filter(isFavourite)
    .sort((a, b) => b.savedAtMs - a.savedAtMs)
    .slice(0, MAX_FAVOURITES);
  return { favourites: Object.fromEntries(kept.map((shop) => [shop.vendorId, shop])) };
}

export function createFavouritesStore(storage: StateStorage<void>): FavouritesStore {
  return create<FavouritesState>()(
    persist<FavouritesState, [], [], PersistedFavouritesState>(
      (set, get) => ({
        favourites: {},
        toggleFavourite: (shop) => {
          const { favourites } = get();
          if (favourites[shop.vendorId] !== undefined) {
            get().removeFavourite(shop.vendorId);
            return false;
          }
          set(
            toPersistedFavourites({
              favourites: { ...favourites, [shop.vendorId]: { ...shop, savedAtMs: Date.now() } },
            }),
          );
          return true;
        },
        removeFavourite: (vendorId) => {
          set((state) => ({
            favourites: Object.fromEntries(
              Object.entries(state.favourites).filter(([id]) => id !== vendorId),
            ),
          }));
        },
        resetFavourites: () => {
          set({ favourites: {} });
        },
      }),
      {
        name: FAVOURITES_STORE_KEY,
        version: FAVOURITES_STORE_VERSION,
        storage: createJSONStorage<PersistedFavouritesState>(() => storage),
        partialize: ({ favourites }): PersistedFavouritesState => ({ favourites }),
        migrate: (persisted) => toPersistedFavourites(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedFavourites(persisted) }),
      },
    ),
  );
}

export const useFavouritesStore: FavouritesStore = createFavouritesStore(
  mmkvStateStorage(getAppStorage()),
);

/** Newest first. */
export function favouriteList(favourites: Record<string, FavouriteShop>): FavouriteShop[] {
  return Object.values(favourites).sort((a, b) => b.savedAtMs - a.savedAtMs);
}

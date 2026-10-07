import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { shopSettingsSchema, type ShopSettings } from '../features/vendor/shop-settings';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';

export const VENDOR_SHOP_STORE_KEY = 'hamro-pasal.vendor-shop';
export const VENDOR_SHOP_STORE_VERSION = 1;

const storedSettingsSchema = z.strictObject({
  /** The account the settings were saved by (the token subject; null if unreadable). */
  userId: z.string().min(1).nullable(),
  settings: shopSettingsSchema,
});
export type StoredShopSettings = z.infer<typeof storedSettingsSchema>;

const deletionRequestSchema = z.strictObject({
  userId: z.string().min(1).nullable(),
  requestedAt: z.iso.datetime(),
});
export type StoredDeletionRequest = z.infer<typeof deletionRequestSchema>;

export interface VendorShopState {
  /**
   * The header's Online / Offline switch. On the phone only for now: the server has no
   * availability flag yet (STATE_HANDOFF.md §8Z.12), so going offline does not stop real orders.
   */
  online: boolean;
  /** PAN, delivery mode, scope and charges, with the account they belong to. */
  stored: StoredShopSettings | null;
  /**
   * The vendor asked for the shop account to be deleted. Kept on the phone only until
   * `POST /api/vendor/deletion-request` exists (STATE_HANDOFF.md §8Z.14): nothing is deleted.
   */
  deletionRequest: StoredDeletionRequest | null;
  setOnline: (online: boolean) => void;
  saveSettings: (settings: ShopSettings, userId: string | null) => void;
  /** Records the request and takes the shop offline. */
  requestDeletion: (userId: string | null, nowMs: number) => void;
  cancelDeletion: () => void;
}

export type PersistedVendorShopState = Pick<
  VendorShopState,
  'online' | 'stored' | 'deletionRequest'
>;

export type VendorShopStore = UseBoundStore<
  Mutate<StoreApi<VendorShopState>, [['zustand/persist', PersistedVendorShopState]]>
>;

/** Whatever was on disk, re-validated: anything that fails the schema is dropped. */
function toPersistedVendorShop(value: unknown): PersistedVendorShopState {
  if (typeof value !== 'object' || value === null) {
    return { online: true, stored: null, deletionRequest: null };
  }
  const stored = storedSettingsSchema.safeParse(Reflect.get(value, 'stored'));
  const deletion = deletionRequestSchema.safeParse(Reflect.get(value, 'deletionRequest'));
  return {
    online: Reflect.get(value, 'online') !== false,
    stored: stored.success ? stored.data : null,
    deletionRequest: deletion.success ? deletion.data : null,
  };
}

export function createVendorShopStore(storage: StateStorage<void>): VendorShopStore {
  return create<VendorShopState>()(
    persist<VendorShopState, [], [], PersistedVendorShopState>(
      (set) => ({
        online: true,
        stored: null,
        deletionRequest: null,
        requestDeletion: (userId, nowMs) => {
          set({
            online: false,
            deletionRequest: { userId, requestedAt: new Date(nowMs).toISOString() },
          });
        },
        cancelDeletion: () => {
          set({ deletionRequest: null });
        },
        setOnline: (online) => {
          set({ online });
        },
        saveSettings: (settings, userId) => {
          set({ stored: { userId, settings: shopSettingsSchema.parse(settings) } });
        },
      }),
      {
        name: VENDOR_SHOP_STORE_KEY,
        version: VENDOR_SHOP_STORE_VERSION,
        storage: createJSONStorage<PersistedVendorShopState>(() => storage),
        partialize: ({ online, stored, deletionRequest }): PersistedVendorShopState => ({
          online,
          stored,
          deletionRequest,
        }),
        migrate: (persisted) => toPersistedVendorShop(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedVendorShop(persisted) }),
      },
    ),
  );
}

/** The settings, only for the account that saved them (another vendor on this phone sees none). */
export function settingsFor(
  stored: StoredShopSettings | null,
  userId: string | null,
): ShopSettings | null {
  if (stored === null || userId === null || stored.userId !== userId) return null;
  return stored.settings;
}

// Encrypted storage: the PAN is the shop's tax identity.
export const useVendorShopStore: VendorShopStore = createVendorShopStore(
  mmkvStateStorage(getSecureStorage()),
);

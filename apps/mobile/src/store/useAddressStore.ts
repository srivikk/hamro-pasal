import { nepalAddressInputSchema, type NepalAddress } from '@hamro-pasal/shared-types';
import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';

export const ADDRESS_STORE_KEY = 'hamro-pasal.delivery-address';
export const ADDRESS_STORE_VERSION = 1;

export interface AddressState {
  /**
   * The active delivery address (SPEC Nepal localizations §3), always a value that passed the
   * shared-types schema. A home address with a precise pin is personal data, so it is kept in the
   * encrypted MMKV instance and restored on the next visit.
   */
  address: NepalAddress | null;
  setAddress: (address: NepalAddress) => void;
  clearAddress: () => void;
}

export type PersistedAddressState = Pick<AddressState, 'address'>;

export type AddressStore = UseBoundStore<
  Mutate<StoreApi<AddressState>, [['zustand/persist', PersistedAddressState]]>
>;

const persistedAddressSchema = z.strictObject({ address: z.unknown() });

/** Re-validates on every restore: a stored address that no longer passes the schema is dropped. */
function toPersistedAddress(value: unknown): PersistedAddressState {
  const envelope = persistedAddressSchema.safeParse(value);
  if (!envelope.success || envelope.data.address === null) return { address: null };
  const address = nepalAddressInputSchema.safeParse(envelope.data.address);
  return { address: address.success ? address.data : null };
}

export function createAddressStore(storage: StateStorage<void>): AddressStore {
  return create<AddressState>()(
    persist<AddressState, [], [], PersistedAddressState>(
      (set) => ({
        address: null,
        setAddress: (address) => {
          // Only schema-valid addresses may become active, whatever the caller did beforehand.
          set({ address: nepalAddressInputSchema.parse(address) });
        },
        clearAddress: () => {
          set({ address: null });
        },
      }),
      {
        name: ADDRESS_STORE_KEY,
        version: ADDRESS_STORE_VERSION,
        storage: createJSONStorage<PersistedAddressState>(() => storage),
        partialize: ({ address }): PersistedAddressState => ({ address }),
        migrate: (persisted) => toPersistedAddress(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedAddress(persisted) }),
      },
    ),
  );
}

export const useAddressStore: AddressStore = createAddressStore(
  mmkvStateStorage(getSecureStorage()),
);

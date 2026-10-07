import {
  NEPAL_PHONE_REGEX,
  nepalAddressInputSchema,
  type NepalAddress,
} from '@hamro-pasal/shared-types';
import * as Crypto from 'expo-crypto';
import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';

export const ADDRESS_STORE_KEY = 'hamro-pasal.delivery-address';
/** v2: an address book (several labelled addresses, one selected). v1 held a single address. */
export const ADDRESS_STORE_VERSION = 2;
export const MAX_SAVED_ADDRESSES = 10;
export const MAX_RECIPIENT_NAME_LENGTH = 80;

export const ADDRESS_LABELS = ['HOME', 'WORK', 'OTHER'] as const;
export type AddressLabel = (typeof ADDRESS_LABELS)[number];

/** Home and Work are unique tags (one address each); any number of addresses may be Other. */
export function isUniqueLabel(label: AddressLabel): boolean {
  return label !== 'OTHER';
}

/** Who receives an order sent to an OTHER address (a friend, a relative). */
export interface AddressRecipient {
  name: string;
  /** Strict +9779XXXXXXXXX. */
  phone: string;
}

/** What the address form produces. `recipient` is set for OTHER and null for HOME / WORK. */
export interface AddressDraft {
  label: AddressLabel;
  recipient: AddressRecipient | null;
  address: NepalAddress;
}

export interface SavedAddress extends AddressDraft {
  id: string;
}

const savedAddressSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    label: z.enum(ADDRESS_LABELS),
    recipient: z
      .strictObject({
        name: z.string().trim().min(1).max(MAX_RECIPIENT_NAME_LENGTH),
        phone: z.string().regex(NEPAL_PHONE_REGEX),
      })
      .nullable(),
    address: nepalAddressInputSchema,
  })
  // Only an OTHER address names a recipient, and it always does.
  .refine((saved) => (saved.label === 'OTHER') === (saved.recipient !== null));

export interface AddressState {
  /**
   * The address book (SPEC Nepal localizations §3 for every entry), always values that passed the
   * schema. Home addresses with a precise pin and other people's phone numbers are personal data,
   * so the book is kept in the encrypted MMKV instance.
   */
  addresses: SavedAddress[];
  selectedId: string | null;
  /** The selected entry's address: what checkout sends and the feed is asked from. Derived. */
  address: NepalAddress | null;
  /**
   * Adds an address (or replaces the one with `id`) and selects it. A Home or Work draft
   * overwrites the entry that already has that tag. Returns the id, or null when the book is
   * full. Throws on a draft that fails the schema.
   */
  saveAddress: (draft: AddressDraft, id?: string) => string | null;
  selectAddress: (id: string) => void;
  /** Removes an entry; if it was selected, the first remaining one becomes selected. */
  removeAddress: (id: string) => void;
  /** Replaces the selected entry's address, or adds it as HOME when the book is empty. */
  setAddress: (address: NepalAddress) => void;
  /** Empties the book. */
  clearAddress: () => void;
}

export type PersistedAddressState = Pick<AddressState, 'addresses' | 'selectedId'>;

export type AddressStore = UseBoundStore<
  Mutate<StoreApi<AddressState>, [['zustand/persist', PersistedAddressState]]>
>;

type BookState = Pick<AddressState, 'addresses' | 'selectedId' | 'address'>;

/** Keeps `selectedId` pointing at an entry and `address` equal to that entry's address. */
function book(addresses: SavedAddress[], wantedId: string | null): BookState {
  const selected = addresses.find((entry) => entry.id === wantedId) ?? addresses[0] ?? null;
  return { addresses, selectedId: selected?.id ?? null, address: selected?.address ?? null };
}

export function selectSelectedAddress(
  state: Pick<AddressState, 'addresses' | 'selectedId'>,
): SavedAddress | null {
  return state.addresses.find((entry) => entry.id === state.selectedId) ?? null;
}

/**
 * Re-validates on every restore: an entry that no longer passes the schema is dropped. A v1 slice
 * (`{ address }`) becomes a book with that one address as HOME.
 */
function toPersistedAddress(value: unknown): PersistedAddressState {
  if (typeof value !== 'object' || value === null) return { addresses: [], selectedId: null };
  const stored: unknown = Reflect.get(value, 'addresses');
  if (Array.isArray(stored)) {
    const addresses: SavedAddress[] = [];
    for (const candidate of stored.slice(0, MAX_SAVED_ADDRESSES)) {
      const parsed = savedAddressSchema.safeParse(candidate);
      if (!parsed.success || addresses.some((entry) => entry.id === parsed.data.id)) continue;
      // A book saved before tags were unique may hold several Home / Work entries: the one
      // saved last wins.
      if (isUniqueLabel(parsed.data.label)) {
        const earlier = addresses.findIndex((entry) => entry.label === parsed.data.label);
        if (earlier !== -1) addresses.splice(earlier, 1);
      }
      addresses.push(parsed.data);
    }
    const selectedId: unknown = Reflect.get(value, 'selectedId');
    const { selectedId: kept } = book(
      addresses,
      typeof selectedId === 'string' ? selectedId : null,
    );
    return { addresses, selectedId: kept };
  }
  const legacy = nepalAddressInputSchema.safeParse(Reflect.get(value, 'address'));
  if (!legacy.success) return { addresses: [], selectedId: null };
  const id = Crypto.randomUUID();
  return {
    addresses: [{ id, label: 'HOME', recipient: null, address: legacy.data }],
    selectedId: id,
  };
}

export function createAddressStore(storage: StateStorage<void>): AddressStore {
  return create<AddressState>()(
    persist<AddressState, [], [], PersistedAddressState>(
      (set, get) => ({
        addresses: [],
        selectedId: null,
        address: null,
        saveAddress: (draft, id) => {
          const { addresses } = get();
          const edited = id === undefined ? undefined : addresses.find((entry) => entry.id === id);
          // Home and Work exist once each: saving another one overwrites the entry that holds
          // the tag. Other addresses are unlimited (up to the book's size).
          const holder = isUniqueLabel(draft.label)
            ? addresses.find((entry) => entry.label === draft.label && entry.id !== edited?.id)
            : undefined;
          const targetId = edited?.id ?? holder?.id;
          if (targetId === undefined && addresses.length >= MAX_SAVED_ADDRESSES) return null;
          // Only schema-valid entries enter the book, whatever the caller did beforehand.
          const saved = savedAddressSchema.parse({
            id: targetId ?? Crypto.randomUUID(),
            label: draft.label,
            recipient: draft.label === 'OTHER' ? draft.recipient : null,
            address: draft.address,
          });
          const next =
            targetId === undefined
              ? [...addresses, saved]
              : addresses
                  .map((entry) => (entry.id === targetId ? saved : entry))
                  // An entry edited INTO a tag another entry held replaces that other entry.
                  .filter((entry) => entry.id === saved.id || entry.id !== holder?.id);
          set(book(next, saved.id));
          return saved.id;
        },
        selectAddress: (id) => {
          const { addresses, selectedId } = get();
          if (addresses.some((entry) => entry.id === id)) set(book(addresses, id));
          else set(book(addresses, selectedId));
        },
        removeAddress: (id) => {
          const { addresses, selectedId } = get();
          set(
            book(
              addresses.filter((entry) => entry.id !== id),
              selectedId,
            ),
          );
        },
        setAddress: (address) => {
          const selected = selectSelectedAddress(get());
          get().saveAddress(
            selected === null
              ? { label: 'HOME', recipient: null, address }
              : { label: selected.label, recipient: selected.recipient, address },
            selected?.id,
          );
        },
        clearAddress: () => {
          set(book([], null));
        },
      }),
      {
        name: ADDRESS_STORE_KEY,
        version: ADDRESS_STORE_VERSION,
        storage: createJSONStorage<PersistedAddressState>(() => storage),
        partialize: ({ addresses, selectedId }): PersistedAddressState => ({
          addresses,
          selectedId,
        }),
        migrate: (persisted) => toPersistedAddress(persisted),
        merge: (persisted, current) => {
          const { addresses, selectedId } = toPersistedAddress(persisted);
          return { ...current, ...book(addresses, selectedId) };
        },
      },
    ),
  );
}

export const useAddressStore: AddressStore = createAddressStore(
  mmkvStateStorage(getSecureStorage()),
);

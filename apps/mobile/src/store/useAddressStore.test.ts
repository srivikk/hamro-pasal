import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { THAMEL_ADDRESS } from '../test/api-fixtures';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import {
  ADDRESS_STORE_KEY,
  ADDRESS_STORE_VERSION,
  createAddressStore,
  MAX_SAVED_ADDRESSES,
  selectSelectedAddress,
  type AddressDraft,
} from './useAddressStore';

const PATAN_ADDRESS = {
  ...THAMEL_ADDRESS,
  district_string: 'Lalitpur',
  municipality_palika_string: 'Lalitpur Metropolitan City',
  ward_number: 16,
  tole_locality: 'Pulchowk',
  exact_lat: 27.6781,
  exact_lng: 85.3167,
};
const HOME: AddressDraft = { label: 'HOME', recipient: null, address: THAMEL_ADDRESS };
const WORK: AddressDraft = { label: 'WORK', recipient: null, address: PATAN_ADDRESS };
const FRIEND: AddressDraft = {
  label: 'OTHER',
  recipient: { name: 'Sita Gurung', phone: '+9779800000002' },
  address: PATAN_ADDRESS,
};

describe('address store', () => {
  let engine: InMemoryMmkv;
  beforeEach(() => {
    engine = new InMemoryMmkv();
  });
  const build = () => createAddressStore(mmkvStateStorage(engine));

  it('hydrates the saved address on the next visit', () => {
    build().getState().setAddress(THAMEL_ADDRESS);

    expect(build().getState().address).toEqual(THAMEL_ADDRESS);
  });

  it('refuses to store an address that fails the shared schema', () => {
    const store = build();

    expect(() => {
      store.getState().setAddress({ ...THAMEL_ADDRESS, ward_number: 34 });
    }).toThrow();
    expect(() => {
      store.getState().setAddress({ ...THAMEL_ADDRESS, province_id: 1 });
    }).toThrow();
    expect(store.getState().address).toBeNull();
  });

  it('clears the address', () => {
    const store = build();
    store.getState().setAddress(THAMEL_ADDRESS);

    store.getState().clearAddress();

    expect(build().getState().address).toBeNull();
  });

  it('drops a stored address that no longer passes the schema', () => {
    engine.set(
      ADDRESS_STORE_KEY,
      JSON.stringify({
        state: { address: { ...THAMEL_ADDRESS, district_string: 'Jhapa' } },
        version: 1,
      }),
    );

    expect(build().getState().address).toBeNull();
    expect(build().getState().addresses).toEqual([]);
  });
});

describe('address book (store v2)', () => {
  let engine: InMemoryMmkv;
  beforeEach(() => {
    engine = new InMemoryMmkv();
  });
  const build = () => createAddressStore(mmkvStateStorage(engine));

  it('keeps several labelled addresses and delivers to the one saved last', () => {
    const store = build();
    const homeId = store.getState().saveAddress(HOME);
    const workId = store.getState().saveAddress(WORK);
    const friendId = store.getState().saveAddress(FRIEND);

    const restored = build().getState();
    expect(restored.addresses.map((entry) => [entry.id, entry.label])).toEqual([
      [homeId, 'HOME'],
      [workId, 'WORK'],
      [friendId, 'OTHER'],
    ]);
    expect(restored.selectedId).toBe(friendId);
    expect(restored.address).toEqual(PATAN_ADDRESS);
    expect(selectSelectedAddress(restored)?.recipient).toEqual(FRIEND.recipient);
  });

  it('switches the delivery address by selecting another entry', () => {
    const store = build();
    const homeId = store.getState().saveAddress(HOME);
    store.getState().saveAddress(WORK);

    store.getState().selectAddress(homeId ?? '');
    store.getState().selectAddress('not-an-entry');

    expect(build().getState().address).toEqual(THAMEL_ADDRESS);
  });

  it('edits an entry in place', () => {
    const store = build();
    const homeId = store.getState().saveAddress(HOME);
    store.getState().saveAddress(FRIEND);

    const edited = store.getState().saveAddress({ ...HOME, address: PATAN_ADDRESS }, homeId ?? '');

    expect(edited).toBe(homeId);
    expect(store.getState().addresses).toHaveLength(2);
    expect(store.getState().addresses[0]).toMatchObject({ id: homeId, address: PATAN_ADDRESS });
    expect(store.getState().selectedId).toBe(homeId);
  });

  it('keeps one Home and one Work: saving another overwrites the existing one', () => {
    const store = build();
    const homeId = store.getState().saveAddress(HOME);
    const workId = store.getState().saveAddress(WORK);

    const secondHome = store.getState().saveAddress({ ...HOME, address: PATAN_ADDRESS });
    const secondWork = store.getState().saveAddress({ ...WORK, address: THAMEL_ADDRESS });

    expect([secondHome, secondWork]).toEqual([homeId, workId]);
    expect(store.getState().addresses).toEqual([
      { id: homeId, label: 'HOME', recipient: null, address: PATAN_ADDRESS },
      { id: workId, label: 'WORK', recipient: null, address: THAMEL_ADDRESS },
    ]);
    expect(build().getState().addresses).toHaveLength(2);
  });

  it('allows any number of Other addresses', () => {
    const store = build();
    store.getState().saveAddress(FRIEND);
    store.getState().saveAddress(FRIEND);

    expect(store.getState().addresses.map((entry) => entry.label)).toEqual(['OTHER', 'OTHER']);
  });

  it('replaces the existing Work entry when another entry is edited into Work', () => {
    const store = build();
    const homeId = store.getState().saveAddress(HOME);
    const workId = store.getState().saveAddress(WORK);
    const friendId = store.getState().saveAddress(FRIEND);

    store.getState().saveAddress({ ...WORK, address: THAMEL_ADDRESS }, friendId ?? '');

    expect(store.getState().addresses.map((entry) => [entry.id, entry.label])).toEqual([
      [homeId, 'HOME'],
      [friendId, 'WORK'],
    ]);
    expect(store.getState().addresses.some((entry) => entry.id === workId)).toBe(false);
    expect(store.getState().selectedId).toBe(friendId);
  });

  it('keeps the last Home when a book stored before tags were unique holds two', () => {
    engine.set(
      ADDRESS_STORE_KEY,
      JSON.stringify({
        state: {
          addresses: [
            { id: 'h1', ...HOME },
            { id: 'o1', ...FRIEND },
            { id: 'h2', ...HOME, address: PATAN_ADDRESS },
          ],
          selectedId: 'h1',
        },
        version: ADDRESS_STORE_VERSION,
      }),
    );

    const state = build().getState();

    expect(state.addresses.map((entry) => entry.id)).toEqual(['o1', 'h2']);
    expect(state.selectedId).toBe('o1');
  });

  it('falls back to the first remaining entry when the selected one is removed', () => {
    const store = build();
    const homeId = store.getState().saveAddress(HOME);
    const workId = store.getState().saveAddress(WORK);

    store.getState().removeAddress(workId ?? '');
    expect(store.getState().selectedId).toBe(homeId);
    store.getState().removeAddress(homeId ?? '');

    expect(store.getState().address).toBeNull();
    expect(build().getState().addresses).toEqual([]);
  });

  it('requires a recipient with a +977 number for OTHER, and stores none for HOME / WORK', () => {
    const store = build();

    expect(() => store.getState().saveAddress({ ...FRIEND, recipient: null })).toThrow();
    expect(() =>
      store.getState().saveAddress({ ...FRIEND, recipient: { name: 'Sita', phone: '9800000002' } }),
    ).toThrow();
    expect(() =>
      store
        .getState()
        .saveAddress({ ...FRIEND, recipient: { name: '  ', phone: '+9779800000002' } }),
    ).toThrow();
    store.getState().saveAddress({ ...HOME, recipient: FRIEND.recipient });

    expect(store.getState().addresses).toMatchObject([{ label: 'HOME', recipient: null }]);
  });

  it('stops at the limit, and still lets an existing entry be edited', () => {
    const store = build();
    const ids = Array.from({ length: MAX_SAVED_ADDRESSES }, () =>
      store.getState().saveAddress(FRIEND),
    );

    expect(store.getState().saveAddress(WORK)).toBeNull();
    expect(store.getState().addresses).toHaveLength(MAX_SAVED_ADDRESSES);
    expect(store.getState().saveAddress(WORK, ids[0] ?? '')).toBe(ids[0]);
  });

  it('migrates a v1 single address into the book as Home', () => {
    engine.set(
      ADDRESS_STORE_KEY,
      JSON.stringify({ state: { address: THAMEL_ADDRESS }, version: 1 }),
    );

    const state = build().getState();

    expect(state.addresses).toMatchObject([
      { label: 'HOME', recipient: null, address: THAMEL_ADDRESS },
    ]);
    expect(state.selectedId).toBe(state.addresses[0]?.id);
    expect(state.address).toEqual(THAMEL_ADDRESS);
  });

  it('drops stored entries that fail the schema and repairs a dangling selection', () => {
    const good = { id: 'a1', ...WORK };
    engine.set(
      ADDRESS_STORE_KEY,
      JSON.stringify({
        state: {
          addresses: [
            { id: 'bad-ward', ...HOME, address: { ...THAMEL_ADDRESS, ward_number: 99 } },
            { id: 'no-recipient', label: 'OTHER', recipient: null, address: PATAN_ADDRESS },
            good,
            good,
          ],
          selectedId: 'bad-ward',
        },
        version: ADDRESS_STORE_VERSION,
      }),
    );

    const state = build().getState();

    expect(state.addresses).toEqual([good]);
    expect(state.selectedId).toBe('a1');
    expect(state.address).toEqual(PATAN_ADDRESS);
  });
});

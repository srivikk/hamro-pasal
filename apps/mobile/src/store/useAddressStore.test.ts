import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { THAMEL_ADDRESS } from '../test/api-fixtures';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import { ADDRESS_STORE_KEY, ADDRESS_STORE_VERSION, createAddressStore } from './useAddressStore';

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
        version: ADDRESS_STORE_VERSION,
      }),
    );

    expect(build().getState().address).toBeNull();
  });
});

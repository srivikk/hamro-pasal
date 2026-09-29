import { mmkvStateStorage, type MmkvEngine } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';
import type * as InMemoryMmkvModule from '../test/in-memory-mmkv';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import { AUTH_STORE_KEY, AUTH_STORE_VERSION, createAuthStore, useAuthStore } from './useAuthStore';

// The app-wide store is wired to the encrypted MMKV instance; replace it with an in-memory engine.
jest.mock('../storage/secure-mmkv', () => {
  const { InMemoryMmkv: Engine } =
    jest.requireActual<typeof InMemoryMmkvModule>('../test/in-memory-mmkv');
  const engine = new Engine();
  return { getSecureStorage: () => engine };
});

const SESSION = { accessToken: 'access.jwt.value', refreshToken: 'refresh.jwt.value' };

function readPersisted(engine: MmkvEngine): unknown {
  const raw = engine.getString(AUTH_STORE_KEY);
  if (raw === undefined) throw new Error('Nothing persisted');
  return JSON.parse(raw);
}

describe('auth store persistence (Zustand + MMKV)', () => {
  let engine: InMemoryMmkv;

  beforeEach(() => {
    engine = new InMemoryMmkv();
  });

  it('starts signed out in English when storage is empty', () => {
    const store = createAuthStore(mmkvStateStorage(engine));

    expect(store.persist.hasHydrated()).toBe(true);
    expect(store.getState()).toMatchObject({ accessToken: null, refreshToken: null, locale: 'en' });
  });

  it('serialises the refresh token and locale, but never the in-memory access token', () => {
    const store = createAuthStore(mmkvStateStorage(engine));

    store.getState().setSession(SESSION);
    store.getState().setLocale('ne');

    expect(store.getState().accessToken).toBe(SESSION.accessToken);
    expect(readPersisted(engine)).toEqual({
      state: { refreshToken: SESSION.refreshToken, locale: 'ne' },
      version: AUTH_STORE_VERSION,
    });
    expect(engine.getString(AUTH_STORE_KEY)).not.toContain(SESSION.accessToken);
  });

  it('hydrates a new store synchronously from what the previous one wrote', () => {
    const first = createAuthStore(mmkvStateStorage(engine));
    first.getState().setSession(SESSION);
    first.getState().setLocale('ne');

    // Simulates an app relaunch: a fresh store over the same MMKV file.
    const relaunched = createAuthStore(mmkvStateStorage(engine));

    expect(relaunched.persist.hasHydrated()).toBe(true);
    expect(relaunched.getState()).toMatchObject({
      accessToken: null,
      refreshToken: SESSION.refreshToken,
      locale: 'ne',
    });
  });

  it('keeps the refresh token when only the access token is rotated', () => {
    const store = createAuthStore(mmkvStateStorage(engine));
    store.getState().setSession(SESSION);

    store.getState().setAccessToken('rotated.access.jwt');

    expect(store.getState()).toMatchObject({
      accessToken: 'rotated.access.jwt',
      refreshToken: SESSION.refreshToken,
    });
    expect(engine.getString(AUTH_STORE_KEY)).not.toContain('rotated.access.jwt');
  });

  it('wipes both tokens on clearSession but keeps the language preference', () => {
    const store = createAuthStore(mmkvStateStorage(engine));
    store.getState().setSession(SESSION);
    store.getState().setLocale('ne');

    store.getState().clearSession();

    expect(store.getState()).toMatchObject({ accessToken: null, refreshToken: null, locale: 'ne' });
    expect(readPersisted(engine)).toEqual({
      state: { refreshToken: null, locale: 'ne' },
      version: AUTH_STORE_VERSION,
    });
    expect(createAuthStore(mmkvStateStorage(engine)).getState().refreshToken).toBeNull();
  });

  it('discards tampered persisted fields instead of trusting them', () => {
    engine.set(
      AUTH_STORE_KEY,
      JSON.stringify({
        state: { refreshToken: 42, locale: 'fr', accessToken: 'smuggled.access.jwt' },
        version: AUTH_STORE_VERSION,
      }),
    );

    const store = createAuthStore(mmkvStateStorage(engine));

    expect(store.getState()).toMatchObject({ accessToken: null, refreshToken: null, locale: 'en' });
  });

  it('migrates a payload from an older schema version through the same validation', () => {
    engine.set(
      AUTH_STORE_KEY,
      JSON.stringify({ state: { refreshToken: 'legacy.refresh', locale: 'ne' }, version: 0 }),
    );

    const store = createAuthStore(mmkvStateStorage(engine));

    expect(store.getState()).toMatchObject({ refreshToken: 'legacy.refresh', locale: 'ne' });
  });

  it('falls back to defaults when the stored JSON is corrupt', () => {
    engine.set(AUTH_STORE_KEY, '{not json');

    const store = createAuthStore(mmkvStateStorage(engine));

    expect(store.getState()).toMatchObject({ refreshToken: null, locale: 'en' });
  });

  it('wires the app-wide useAuthStore to the secure MMKV instance', () => {
    useAuthStore.getState().setSession(SESSION);

    expect(readPersisted(getSecureStorage())).toEqual({
      state: { refreshToken: SESSION.refreshToken, locale: 'en' },
      version: AUTH_STORE_VERSION,
    });
  });
});

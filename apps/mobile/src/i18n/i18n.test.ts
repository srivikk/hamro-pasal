import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { createAuthStore } from '../store/useAuthStore';
import { InMemoryMmkv } from '../test/in-memory-mmkv';
import { formatLocalizedNumber } from './format-number';
import { bindLocale, createI18n } from './i18n';

jest.mock('../storage/secure-mmkv', () => ({
  getSecureStorage: () => ({
    getString: () => undefined,
    set: () => undefined,
    remove: () => true,
  }),
}));

describe('i18n configuration', () => {
  it('initialises synchronously in the requested locale', () => {
    const i18n = createI18n('ne');

    expect(i18n.isInitialized).toBe(true);
    expect(i18n.t('common.appName')).toBe('हाम्रो पसल');
  });

  it('keeps ASCII digits in English', () => {
    const i18n = createI18n('en');

    expect(i18n.t('common.price', { amount: 1250.5 })).toBe('Rs. 1250.5');
    expect(i18n.t('cart.itemCount', { count: 1 })).toBe('1 item');
    expect(i18n.t('cart.itemCount', { count: 12 })).toBe('12 items');
  });

  it('renders Devanagari numerals after switching to ne', async () => {
    const i18n = createI18n('en');

    await i18n.changeLanguage('ne');

    expect(i18n.t('common.price', { amount: 1250.5 })).toBe('रु. १२५०.५');
    expect(i18n.t('cart.itemCount', { count: 3 })).toBe('३ वटा सामान');
    expect(i18n.t('common.price', { amount: 1234567890 })).toBe('रु. १२३४५६७८९०');
  });

  it('switches back to ASCII digits when returning to en', async () => {
    const i18n = createI18n('ne');

    await i18n.changeLanguage('en');

    expect(i18n.t('common.price', { amount: 90 })).toBe('Rs. 90');
  });

  it('follows the locale preference stored in the auth store', () => {
    const store = createAuthStore(mmkvStateStorage(new InMemoryMmkv()));
    const i18n = createI18n('en');
    const unbind = bindLocale(i18n, store);

    store.getState().setLocale('ne');
    expect(i18n.language).toBe('ne');
    expect(i18n.t('common.price', { amount: 500 })).toBe('रु. ५००');

    store.getState().setLocale('en');
    expect(i18n.t('common.price', { amount: 500 })).toBe('Rs. 500');

    unbind();
    store.getState().setLocale('ne');
    expect(i18n.language).toBe('en');
  });

  it('applies a locale already persisted before binding', () => {
    const engine = new InMemoryMmkv();
    createAuthStore(mmkvStateStorage(engine)).getState().setLocale('ne');
    const i18n = createI18n('en');

    bindLocale(i18n, createAuthStore(mmkvStateStorage(engine)));

    expect(i18n.t('cart.itemCount', { count: 7 })).toBe('७ वटा सामान');
  });

  it('ships the same translation keys in en.json and ne.json', () => {
    const keysOf = (value: unknown, prefix = ''): string[] =>
      typeof value === 'object' && value !== null
        ? Object.entries(value).flatMap(([key, child]) => keysOf(child, `${prefix}${key}.`))
        : [prefix.slice(0, -1)];
    const i18n = createI18n();

    expect(keysOf(i18n.getResourceBundle('ne', 'translation')).sort()).toEqual(
      keysOf(i18n.getResourceBundle('en', 'translation')).sort(),
    );
  });
});

describe('formatLocalizedNumber', () => {
  it.each([
    [0, 'en', '0'],
    [-0, 'en', '0'],
    [1234567, 'en', '1234567'],
    [-45.25, 'en', '-45.25'],
    [0.000001, 'en', '0.000001'],
    [0, 'ne', '०'],
    [1234567, 'ne', '१२३४५६७'],
    [-45.25, 'ne', '-४५.२५'],
  ] as const)('formats %p in %s as %p', (value, locale, expected) => {
    expect(formatLocalizedNumber(value, locale)).toBe(expected);
  });

  it.each(['en', 'ne'] as const)('rejects non-finite values in %s', (locale) => {
    expect(() => formatLocalizedNumber(Number.NaN, locale)).toThrow(RangeError);
    expect(() => formatLocalizedNumber(Number.POSITIVE_INFINITY, locale)).toThrow(RangeError);
  });
});

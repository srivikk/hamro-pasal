import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { DEFAULT_LOCALE, isAppLocale, type AppLocale } from './app-locale';
import { formatLocalizedNumber } from './format-number';
import en from './locales/en.json';
import ne from './locales/ne.json';

/** Interpolation format that renders numbers in the active locale's digits: `{{amount, localizedNumber}}`. */
export const LOCALIZED_NUMBER_FORMAT = 'localizedNumber';

export const resources = {
  en: { translation: en },
  ne: { translation: ne },
} as const;

/**
 * Creates an isolated, synchronously initialised i18next instance. Resources are bundled, so
 * `initAsync: false` makes translations available before the first render.
 */
export function createI18n(locale: AppLocale = DEFAULT_LOCALE): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: ['en', 'ne'],
    initAsync: false,
    returnNull: false,
    // React Native renders text natively, so HTML escaping would only corrupt strings.
    interpolation: { escapeValue: false },
  });
  instance.services.formatter?.add(
    LOCALIZED_NUMBER_FORMAT,
    (value: unknown, lng: string | undefined): string =>
      typeof value === 'number'
        ? formatLocalizedNumber(value, isAppLocale(lng) ? lng : DEFAULT_LOCALE)
        : String(value),
  );
  return instance;
}

/** Keeps i18next's language in step with the persisted locale preference. Returns the unsubscribe. */
export function bindLocale(
  instance: I18n,
  store: {
    getState: () => { locale: AppLocale };
    subscribe: (listener: (state: { locale: AppLocale }) => void) => () => void;
  },
): () => void {
  const apply = (locale: AppLocale): void => {
    if (instance.language !== locale) void instance.changeLanguage(locale);
  };
  apply(store.getState().locale);
  return store.subscribe(({ locale }) => {
    apply(locale);
  });
}

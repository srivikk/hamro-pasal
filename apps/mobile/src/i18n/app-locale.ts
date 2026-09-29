/** Supported UI languages (SPEC implicit requirement 2): English and Nepali. */
export const APP_LOCALES = ['en', 'ne'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en';

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}

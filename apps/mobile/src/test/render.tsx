import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';

import type { AppLocale } from '../i18n/app-locale';
import { createI18n } from '../i18n/i18n';

/** Renders with the same providers as app/_layout.tsx: a fresh QueryClient (no retries, no GC timers) and i18n. */
export function renderWithProviders(
  ui: ReactElement,
  { locale = 'en' }: { locale?: AppLocale } = {},
) {
  // gcTime Infinity schedules no garbage-collection timers, so Jest workers exit cleanly.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={createI18n(locale)}>{ui}</I18nextProvider>
    </QueryClientProvider>,
  );
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import type { AppLocale } from '../i18n/app-locale';
import { createI18n } from '../i18n/i18n';

/** No retries (failures surface at once) and no GC timers, so Jest workers exit cleanly. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  });
}

function providers(locale: AppLocale) {
  const queryClient = createTestQueryClient();
  const i18n = createI18n(locale);
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </QueryClientProvider>
    );
  };
}

/** Renders with the same providers as app/_layout.tsx: a fresh QueryClient and i18n. */
export function renderWithProviders(
  ui: ReactElement,
  { locale = 'en' }: { locale?: AppLocale } = {},
) {
  return render(ui, { wrapper: providers(locale) });
}

export function renderHookWithProviders<Result>(
  hook: () => Result,
  { locale = 'en' }: { locale?: AppLocale } = {},
) {
  return renderHook(hook, { wrapper: providers(locale) });
}

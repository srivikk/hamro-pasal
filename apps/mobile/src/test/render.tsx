import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import type { AppLocale } from '../i18n/app-locale';
import { createI18n } from '../i18n/i18n';

/** No retries (failures surface at once) and no GC timers, so Jest workers exit cleanly. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
}

/** Fixed metrics: Expo Router provides the SafeAreaProvider in the app, tests supply their own. */
const TEST_SAFE_AREA: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function providers(locale: AppLocale, queryClient: QueryClient = createTestQueryClient()) {
  const i18n = createI18n(locale);
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <SafeAreaProvider initialMetrics={TEST_SAFE_AREA}>
        <QueryClientProvider client={queryClient}>
          <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );
  };
}

/**
 * Renders with the same providers as app/_layout.tsx: a fresh QueryClient (or the given one, so a
 * test can inspect the cache) and i18n.
 */
export function renderWithProviders(
  ui: ReactElement,
  { locale = 'en', queryClient }: { locale?: AppLocale; queryClient?: QueryClient } = {},
) {
  return render(ui, { wrapper: providers(locale, queryClient) });
}

export function renderHookWithProviders<Result, Props = undefined>(
  hook: (props: Props) => Result,
  {
    locale = 'en',
    initialProps,
    queryClient,
  }: { locale?: AppLocale; initialProps?: Props; queryClient?: QueryClient } = {},
) {
  return renderHook(hook, {
    wrapper: providers(locale, queryClient),
    ...(initialProps === undefined ? {} : { initialProps }),
  });
}

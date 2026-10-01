import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createAdminApi } from './api/admin-api';
import { createApiClient } from './api/client';
import { App } from './App';
import { AdminProvider, retryTransientFailures } from './app-context';
import { createSessionStore } from './auth/session-store';
import './styles.css';

const session = createSessionStore();
// Same origin: Vite proxies /api to the API in development (vite.config.ts).
const api = createAdminApi(
  createApiClient({ baseUrl: '', fetch: (url, init) => window.fetch(url, init), session }),
);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: retryTransientFailures, staleTime: 0, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});
// Signing out (or a refused token refresh) must not leave another admin's data in the cache; nor
// may a refresh that answers for a different admin (another tab signed in with the shared cookie).
session.subscribe((state, previous) => {
  if (previous.session !== null && previous.session.user.id !== state.session?.user.id) {
    queryClient.clear();
  }
});

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <AdminProvider api={api} session={session}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AdminProvider>
  </StrictMode>,
);

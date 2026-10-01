import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { AdminApi } from './api/admin-api';
import { ApiError } from './api/client';
import type { AdminSession, SessionState } from './auth/session-store';

interface AdminContextValue {
  readonly api: AdminApi;
  readonly session: StoreApi<SessionState>;
}

const AdminContext = createContext<AdminContextValue | null>(null);

export function AdminProvider({
  api,
  session,
  children,
}: AdminContextValue & { readonly children: ReactNode }) {
  return <AdminContext.Provider value={{ api, session }}>{children}</AdminContext.Provider>;
}

function useAdminContext(): AdminContextValue {
  const value = useContext(AdminContext);
  if (value === null) throw new Error('AdminProvider is missing');
  return value;
}

export function useAdminApi(): AdminApi {
  return useAdminContext().api;
}

export function useSessionStore(): StoreApi<SessionState> {
  return useAdminContext().session;
}

export function useSession(): AdminSession | null {
  return useStore(useSessionStore(), (state) => state.session);
}

/** Queries retry network errors and 5xx (twice); a 4xx answer is final. */
export function retryTransientFailures(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status >= 500;
}

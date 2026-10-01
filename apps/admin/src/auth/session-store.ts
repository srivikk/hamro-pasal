import type { AuthUser } from '@hamro-pasal/shared-types';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface AdminSession {
  readonly phone: string;
  readonly user: AuthUser;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface SessionState {
  readonly session: AdminSession | null;
  setSession(session: AdminSession): void;
  /** A refreshed access token; ignored when nobody is signed in. */
  setAccessToken(accessToken: string): void;
  clear(): void;
}

/**
 * The signed-in Super Admin, held in memory only (SPEC implicit requirement 3: access tokens never
 * in unencrypted storage). The refresh token stays in memory too: a browser has no encrypted
 * storage, so reloading the page signs the admin out. An HttpOnly refresh cookie would lift this
 * (see STATE_HANDOFF §8I).
 */
export function createSessionStore(): StoreApi<SessionState> {
  return createStore<SessionState>()((set) => ({
    session: null,
    setSession: (session) => {
      set({ session });
    },
    setAccessToken: (accessToken) => {
      set((state) =>
        state.session === null ? state : { session: { ...state.session, accessToken } },
      );
    },
    clear: () => {
      set({ session: null });
    },
  }));
}

import type { AuthUser } from '@hamro-pasal/shared-types';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface AdminSession {
  readonly phone: string;
  readonly user: AuthUser;
  readonly accessToken: string;
  /**
   * Vendors only (Phase 19): the refresh token of the sign-in answer, held in memory like the
   * access token. A Super Admin has none here: theirs is the HttpOnly cookie.
   */
  readonly refreshToken?: string;
}

export interface SessionState {
  readonly session: AdminSession | null;
  setSession(session: AdminSession): void;
  /** A refreshed access token; ignored when nobody is signed in. */
  setAccessToken(accessToken: string): void;
  clear(): void;
}

/**
 * The signed-in Super Admin or vendor, held in memory only (SPEC implicit requirement 3: tokens
 * never in unencrypted storage). A Super Admin's refresh token is not here at all: it lives in an
 * HttpOnly cookie that no script can read, and the API client trades it for a new access token
 * (also after a page reload, STATE_HANDOFF §8J). A vendor's refresh token arrives in the sign-in
 * body (the API sets the cookie for Super Admins only) and is kept here, so a reload signs a
 * vendor out.
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

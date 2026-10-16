import { create } from 'zustand';

/**
 * Step 7.7: the Seller app's sign-in proved a number that has no shop yet. The short-lived signup
 * token it was given is held in memory only (never persisted) until the signup form is sent.
 */
interface SellerSignupState {
  phone: string | null;
  token: string | null;
  expiresAt: number | null;
  start: (phone: string, token: string, expiresInSeconds: number) => void;
  clear: () => void;
}

export const useSellerSignupStore = create<SellerSignupState>()((set) => ({
  phone: null,
  token: null,
  expiresAt: null,
  start: (phone, token, expiresInSeconds) => {
    set({ phone, token, expiresAt: Date.now() + expiresInSeconds * 1000 });
  },
  clear: () => {
    set({ phone: null, token: null, expiresAt: null });
  },
}));

/** A token still worth sending (with a minute to spare for filling in the form). */
export function selectUsableSignupToken(state: SellerSignupState): string | null {
  return state.token !== null && state.expiresAt !== null && state.expiresAt - Date.now() > 0
    ? state.token
    : null;
}

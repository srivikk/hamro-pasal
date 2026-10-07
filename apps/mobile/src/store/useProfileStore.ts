import { z } from 'zod';
import { create, type Mutate, type StoreApi, type UseBoundStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import { tokenSubject } from '../lib/access-token-role';
import { mmkvStateStorage } from '../storage/mmkv-state-storage';
import { getSecureStorage } from '../storage/secure-mmkv';
import type { AuthState } from './useAuthStore';

export const PROFILE_STORE_KEY = 'hamro-pasal.profile';
/** v2 added `consents` and `onboarding`; a v1 slice keeps its profile and account. */
export const PROFILE_STORE_VERSION = 2;
export const MIN_FULL_NAME_LENGTH = 2;
export const MAX_FULL_NAME_LENGTH = 80;
export const MAX_EMAIL_LENGTH = 254;

export const profileDetailsSchema = z.strictObject({
  full_name: z.string().trim().min(MIN_FULL_NAME_LENGTH).max(MAX_FULL_NAME_LENGTH),
  /** Optional: null when the customer gave none. */
  email: z.email().max(MAX_EMAIL_LENGTH).nullable(),
});
export type ProfileDetails = z.infer<typeof profileDetailsSchema>;

const storedProfileSchema = profileDetailsSchema.extend({ user_id: z.string().min(1).nullable() });
/** The details and the account they were entered for (the token subject; null if unreadable). */
export type StoredProfile = z.infer<typeof storedProfileSchema>;

const accountSchema = z.strictObject({
  user_id: z.string().min(1).nullable(),
  /** Strict +9779XXXXXXXXX, as the customer signed in with it. */
  phone: z.string().min(1).max(20),
});
/** The number the signed-in account verified, kept to show it on the Profile tab. */
export type StoredAccount = z.infer<typeof accountSchema>;

const consentsSchema = z.strictObject({
  user_id: z.string().min(1).nullable(),
  /** When the Terms & Conditions and Privacy Policy were accepted; null until they are. */
  terms_accepted_at: z.iso.datetime({ offset: true }).nullable(),
  /** "Get updates on WhatsApp": optional, off unless the customer switched it on. */
  whatsapp_opt_in: z.boolean(),
});
/** The account's consents as this phone last knew them (the server's copy is the record). */
export type StoredConsents = z.infer<typeof consentsSchema>;
export type ConsentDetails = Omit<StoredConsents, 'user_id'>;

const onboardingSchema = z.strictObject({ user_id: z.string().min(1).nullable() });
/** The account that was just created by an OTP sign-in and has not completed its profile yet. */
export type PendingOnboarding = z.infer<typeof onboardingSchema>;

export interface ProfileState {
  /**
   * The customer's name and (optional) email, as entered on this device. LOCAL ONLY until the API has a
   * profile endpoint (STATE_HANDOFF §8S): nothing here is sent to the server yet. Kept in the
   * encrypted MMKV instance, and tied to the account it was entered for.
   */
  profile: StoredProfile | null;
  /** Set when an OTP is verified on this phone; tied to the account like the profile. */
  account: StoredAccount | null;
  setAccount: (phone: string, userId: string | null) => void;
  /** Throws on details that fail the schema. */
  setProfile: (details: ProfileDetails, userId: string | null) => void;
  clearProfile: () => void;
  consents: StoredConsents | null;
  /**
   * Set when an OTP sign-in created the account; cleared when its profile is saved. While it is
   * set for the signed-in account, the customer screens send them to "Complete your profile".
   */
  onboarding: PendingOnboarding | null;
  setConsents: (consents: ConsentDetails, userId: string | null) => void;
  /** Changes the WhatsApp choice only; the terms timestamp of the same account is kept. */
  setWhatsAppOptIn: (optIn: boolean, userId: string | null) => void;
  requireOnboarding: (userId: string | null) => void;
  completeOnboarding: () => void;
}

export type PersistedProfileState = Pick<
  ProfileState,
  'profile' | 'account' | 'consents' | 'onboarding'
>;

export type ProfileStore = UseBoundStore<
  Mutate<StoreApi<ProfileState>, [['zustand/persist', PersistedProfileState]]>
>;

function toPersistedProfile(value: unknown): PersistedProfileState {
  if (typeof value !== 'object' || value === null) {
    return { profile: null, account: null, consents: null, onboarding: null };
  }
  const profile = storedProfileSchema.safeParse(Reflect.get(value, 'profile'));
  const account = accountSchema.safeParse(Reflect.get(value, 'account'));
  const consents = consentsSchema.safeParse(Reflect.get(value, 'consents'));
  const onboarding = onboardingSchema.safeParse(Reflect.get(value, 'onboarding'));
  return {
    profile: profile.success ? profile.data : null,
    account: account.success ? account.data : null,
    consents: consents.success ? consents.data : null,
    onboarding: onboarding.success ? onboarding.data : null,
  };
}

export function createProfileStore(storage: StateStorage<void>): ProfileStore {
  return create<ProfileState>()(
    persist<ProfileState, [], [], PersistedProfileState>(
      (set) => ({
        profile: null,
        account: null,
        setAccount: (phone, userId) => {
          set({ account: accountSchema.parse({ phone, user_id: userId }) });
        },
        setProfile: (details, userId) => {
          set({ profile: { ...profileDetailsSchema.parse(details), user_id: userId } });
        },
        clearProfile: () => {
          set({ profile: null });
        },
        consents: null,
        onboarding: null,
        setConsents: (consents, userId) => {
          set({ consents: consentsSchema.parse({ ...consents, user_id: userId }) });
        },
        setWhatsAppOptIn: (optIn, userId) => {
          set(({ consents }) => ({
            consents: {
              user_id: userId,
              terms_accepted_at: consents?.user_id === userId ? consents.terms_accepted_at : null,
              whatsapp_opt_in: optIn,
            },
          }));
        },
        requireOnboarding: (userId) => {
          set({ onboarding: { user_id: userId } });
        },
        completeOnboarding: () => {
          set({ onboarding: null });
        },
      }),
      {
        name: PROFILE_STORE_KEY,
        version: PROFILE_STORE_VERSION,
        storage: createJSONStorage<PersistedProfileState>(() => storage),
        partialize: ({ profile, account, consents, onboarding }): PersistedProfileState => ({
          profile,
          account,
          consents,
          onboarding,
        }),
        migrate: (persisted) => toPersistedProfile(persisted),
        merge: (persisted, current) => ({ ...current, ...toPersistedProfile(persisted) }),
      },
    ),
  );
}

export const useProfileStore: ProfileStore = createProfileStore(
  mmkvStateStorage(getSecureStorage()),
);

/** The signed-in account's id: the subject of whichever token the session holds. */
export function selectSessionUserId(
  state: Pick<AuthState, 'accessToken' | 'refreshToken'>,
): string | null {
  const token = state.accessToken ?? state.refreshToken;
  return token === null ? null : tokenSubject(token);
}

/** The stored profile if it belongs to `userId`; another account's details are never shown. */
export function profileFor(
  profile: StoredProfile | null,
  userId: string | null,
): StoredProfile | null {
  return profile !== null && profile.user_id === userId ? profile : null;
}

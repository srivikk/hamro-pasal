import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import {
  profileDetailsSchema,
  profileFor,
  selectSessionUserId,
  useProfileStore,
  type ProfileDetails,
  type StoredConsents,
  type StoredProfile,
} from '../../store/useProfileStore';

export type ProfileField = 'full_name' | 'email';

export type ProfileValidation =
  | { ok: true; details: ProfileDetails }
  | { ok: false; errors: Partial<Record<ProfileField, true>> };

/**
 * Validates what was typed: a name of 2-80 characters (required) and an email that is optional
 * but, when given, must be well formed. A blank email is stored as null.
 */
export function validateProfileForm(fullName: string, email: string): ProfileValidation {
  const trimmedEmail = email.trim();
  const result = profileDetailsSchema.safeParse({
    full_name: fullName,
    email: trimmedEmail === '' ? null : trimmedEmail,
  });
  if (result.success) return { ok: true, details: result.data };
  const errors: Partial<Record<ProfileField, true>> = {};
  for (const issue of result.error.issues) {
    const [field] = issue.path;
    if (field === 'full_name' || field === 'email') errors[field] = true;
  }
  return { ok: false, errors };
}

/**
 * The signed-in account's profile, or null while it is incomplete (no name yet, or entered for
 * another account on this phone). Checkout is offered only once it exists.
 */
/** The number the signed-in account verified on this phone, or null (e.g. a pasted dev token). */
export function useCurrentPhone(): string | null {
  const userId = useAuthStore(selectSessionUserId);
  const account = useProfileStore((state) => state.account);
  return account !== null && account.user_id === userId ? account.phone : null;
}

/** The signed-in account's consents as this phone knows them, or null (never another account's). */
export function useCurrentConsents(): StoredConsents | null {
  const userId = useAuthStore(selectSessionUserId);
  const consents = useProfileStore((state) => state.consents);
  return consents !== null && consents.user_id === userId ? consents : null;
}

/**
 * True while the signed-in account was created by its OTP sign-in and has not saved its profile:
 * the app then shows "Complete your profile" before anything else.
 */
export function useOnboardingRequired(): boolean {
  const userId = useAuthStore(selectSessionUserId);
  const signedIn = useAuthStore(selectHasSession);
  const onboarding = useProfileStore((state) => state.onboarding);
  return signedIn && onboarding !== null && onboarding.user_id === userId;
}

export function useCurrentProfile(): StoredProfile | null {
  const userId = useAuthStore(selectSessionUserId);
  const profile = useProfileStore((state) => state.profile);
  return profileFor(profile, userId);
}

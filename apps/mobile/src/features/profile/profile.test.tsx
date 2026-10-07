import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import type * as ReactNativeModule from 'react-native';

import CompleteProfileScreen from '../../../app/complete-profile';
import { tokenSubject } from '../../lib/access-token-role';
import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { useAuthStore } from '../../store/useAuthStore';
import {
  createProfileStore,
  PROFILE_STORE_KEY,
  profileFor,
  selectSessionUserId,
  useProfileStore,
} from '../../store/useProfileStore';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { validateProfileForm } from './profile-form';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: ({ href }: { href: string }) => {
    const { Text } = jest.requireActual<typeof ReactNativeModule>('react-native');
    return <Text>{`redirect:${href}`}</Text>;
  },
}));
const mockRouter = jest.mocked(router);

/** An unsigned token with the given subject (the app never verifies signatures). */
function tokenFor(subject: string): string {
  const base64url = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${base64url({ alg: 'HS256' })}.${base64url({ sub: subject, role: 'CUSTOMER' })}.sig`;
}

// Saving goes to PATCH /api/me (answered by the standing account handlers of the test server).
setupApiTestEnvironment();

const AARAV = '0c1d0000-0000-4000-8000-000000000001';
const SITA = '0c1d0000-0000-4000-8000-000000000002';

beforeEach(() => {
  jest.clearAllMocks();
  mockRouter.canGoBack.mockReturnValue(true);
  useProfileStore.getState().clearProfile();
  useProfileStore.setState({ consents: null, onboarding: null });
  useAuthStore
    .getState()
    .setSession({ accessToken: tokenFor(AARAV), refreshToken: tokenFor(AARAV) });
});

afterAll(() => {
  useAuthStore.getState().clearSession();
  useProfileStore.getState().clearProfile();
});

describe('tokenSubject', () => {
  it('reads the account id from a token, and null from anything else', () => {
    expect(tokenSubject(tokenFor(AARAV))).toBe(AARAV);
    expect(tokenSubject('a.b.c')).toBeNull();
    expect(tokenSubject('garbage')).toBeNull();
  });

  it('identifies the session by the access token, else the refresh token', () => {
    expect(
      selectSessionUserId({ accessToken: tokenFor(AARAV), refreshToken: tokenFor(SITA) }),
    ).toBe(AARAV);
    expect(selectSessionUserId({ accessToken: null, refreshToken: tokenFor(SITA) })).toBe(SITA);
    expect(selectSessionUserId({ accessToken: null, refreshToken: null })).toBeNull();
  });
});

describe('validateProfileForm', () => {
  it('accepts a name and an email, trimmed', () => {
    expect(validateProfileForm('  Aarav Shrestha ', ' aarav@example.com ')).toEqual({
      ok: true,
      details: { full_name: 'Aarav Shrestha', email: 'aarav@example.com' },
    });
  });

  it.each([
    ['', 'aarav@example.com', ['full_name']],
    ['A', 'aarav@example.com', ['full_name']],
    ['Aarav Shrestha', 'aarav@', ['email']],
    ['Aarav Shrestha', 'not an email', ['email']],
    ['', '', ['full_name']],
    ['', 'nope', ['full_name', 'email']],
  ])('rejects name %p with email %p', (name, email, fields) => {
    const result = validateProfileForm(name, email);

    expect(result.ok ? [] : Object.keys(result.errors).sort()).toEqual([...fields].sort());
  });
});

describe('validateProfileForm: the email is optional', () => {
  it.each(['', '   '])('accepts a name alone and stores no email for %p', (email) => {
    expect(validateProfileForm('Aarav Shrestha', email)).toEqual({
      ok: true,
      details: { full_name: 'Aarav Shrestha', email: null },
    });
  });
});

describe('profile store', () => {
  it('persists the details with the account they belong to, in the given storage', () => {
    const engine = new InMemoryMmkv();
    const build = () => createProfileStore(mmkvStateStorage(engine));

    build()
      .getState()
      .setProfile({ full_name: 'Aarav Shrestha', email: 'aarav@example.com' }, AARAV);

    expect(build().getState().profile).toEqual({
      full_name: 'Aarav Shrestha',
      email: 'aarav@example.com',
      user_id: AARAV,
    });
  });

  it('refuses invalid details and drops a stored profile that fails the schema', () => {
    const engine = new InMemoryMmkv();
    const build = () => createProfileStore(mmkvStateStorage(engine));

    expect(() => {
      build().getState().setProfile({ full_name: 'Aarav', email: 'nope' }, AARAV);
    }).toThrow();
    engine.set(
      PROFILE_STORE_KEY,
      JSON.stringify({ state: { profile: { full_name: 'A', email: 'x' } }, version: 1 }),
    );

    expect(build().getState().profile).toBeNull();
  });

  it('never hands one account the details entered for another', () => {
    const profile = { full_name: 'Aarav Shrestha', email: 'aarav@example.com', user_id: AARAV };

    expect(profileFor(profile, AARAV)).toBe(profile);
    expect(profileFor(profile, SITA)).toBeNull();
    expect(profileFor(null, AARAV)).toBeNull();
  });
});

describe('Complete Profile screen', () => {
  it('saves the name and email for the signed-in account and returns to the caller', async () => {
    renderWithProviders(<CompleteProfileScreen />);

    fireEvent.changeText(screen.getByTestId('profile-full-name'), 'Aarav Shrestha');
    fireEvent.changeText(screen.getByTestId('profile-email'), 'aarav@example.com');
    fireEvent.press(screen.getByTestId('profile-terms'));
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
    expect(useProfileStore.getState().profile).toEqual({
      full_name: 'Aarav Shrestha',
      email: 'aarav@example.com',
      user_id: AARAV,
    });
  });

  it('saves a name without an email', async () => {
    renderWithProviders(<CompleteProfileScreen />);

    fireEvent.changeText(screen.getByTestId('profile-full-name'), 'Aarav Shrestha');
    fireEvent.press(screen.getByTestId('profile-terms'));
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
    expect(useProfileStore.getState().profile).toEqual({
      full_name: 'Aarav Shrestha',
      email: null,
      user_id: AARAV,
    });
  });

  it('shows what is wrong and saves nothing', () => {
    renderWithProviders(<CompleteProfileScreen />);

    fireEvent.changeText(screen.getByTestId('profile-email'), 'aarav@');
    fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByTestId('profile-error-full_name')).toHaveTextContent(
      'Enter your full name.',
    );
    expect(screen.getByTestId('profile-error-email')).toHaveTextContent(
      'Enter a valid email address.',
    );
    expect(useProfileStore.getState().profile).toBeNull();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('pre-fills the current details for editing, but not another account’s', () => {
    useProfileStore
      .getState()
      .setProfile({ full_name: 'Aarav Shrestha', email: 'aarav@example.com' }, AARAV);
    const first = renderWithProviders(<CompleteProfileScreen />);
    expect(screen.getByTestId('profile-full-name').props.value).toBe('Aarav Shrestha');
    first.unmount();

    useAuthStore
      .getState()
      .setSession({ accessToken: tokenFor(SITA), refreshToken: tokenFor(SITA) });
    renderWithProviders(<CompleteProfileScreen />);

    expect(screen.getByTestId('profile-full-name').props.value).toBe('');
    expect(screen.getByTestId('profile-email').props.value).toBe('');
  });

  it('sends a signed-out visitor to sign in', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<CompleteProfileScreen />);

    expect(screen.getByText('redirect:/login')).toBeOnTheScreen();
  });
});

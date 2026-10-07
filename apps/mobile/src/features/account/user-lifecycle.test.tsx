import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import { Alert, KeyboardAvoidingView, Platform } from 'react-native';
import type * as ReactNativeModule from 'react-native';

import ProfileScreen from '../../../app/(tabs)/profile';
import CompleteProfileScreen from '../../../app/complete-profile';
import LanguageScreen from '../../../app/language';
import LoginScreen from '../../../app/login';
import AboutScreen from '../../../app/settings/about';
import AppearanceScreen from '../../../app/settings/appearance';
import NotificationPreferencesScreen from '../../../app/settings/notifications';
import AccountPrivacyScreen from '../../../app/settings/privacy';
import VerifyOtpScreen from '../../../app/verify-otp';
import {
  DELETION_ELIGIBILITY_PATH,
  DELETION_REQUEST_PATH,
  ME_PATH,
  updateAccount,
} from '../../api/account';
import { OTP_VERIFY_PATH } from '../../api/auth';
import { VendorCard } from '../../components/VendorCard';
import { accountMockHandlers } from '../../mocks/account-handlers';
import { openOrderCount } from '../../mocks/dev-mocks';
import { mmkvStateStorage } from '../../storage/mmkv-state-storage';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useFavouritesStore } from '../../store/useFavouritesStore';
import {
  createOnboardingStore,
  ONBOARDING_STORE_KEY,
  useOnboardingStore,
} from '../../store/useOnboardingStore';
import { useOrderStore } from '../../store/useOrderStore';
import { createProfileStore, useProfileStore } from '../../store/useProfileStore';
import { useThemeStore } from '../../store/useThemeStore';
import { useToastStore } from '../../store/useToastStore';
import { accessTokenFor } from '../../test/access-tokens';
import { authTokensResponse, feedResponse, TEST_PHONE } from '../../test/api-fixtures';
import { InMemoryMmkv } from '../../test/in-memory-mmkv';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { nextPhoneDraft, phoneInputMaxLength } from '../auth/login-form';
import { NO_VENDOR_EXTRAS } from '../promo/promo-model';
import { vendorExtras } from '../promo/mock-promotions';
import { ShopHeader } from '../menu/ShopHeader';
import { LanguageToggle } from '../settings/LanguageToggle';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: ({ href }: { href: string }) => {
    const { Text } = jest.requireActual<typeof ReactNativeModule>('react-native');
    return <Text>{`redirect:${href}`}</Text>;
  },
  useLocalSearchParams: () => mockParams,
}));
const mockRouter = jest.mocked(router);

jest.mock('../promo/mock-promotions', () => ({
  ...jest.requireActual<Record<string, unknown>>('../promo/mock-promotions'),
  vendorExtras: jest.fn(),
}));

setupApiTestEnvironment();

const USER_ID = '9f1c2a10-0000-4000-8000-000000000001';
const ACCEPTED_AT = '2026-10-07T06:15:00.000Z';

function signIn(): void {
  useAuthStore
    .getState()
    .setSession({ accessToken: accessTokenFor('CUSTOMER', USER_ID), refreshToken: 'r.jwt' });
}

/** Records every PATCH /api/me body; the standing handler's answer is replaced by `respond`. */
function servePatch(respond?: (body: Record<string, unknown>) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const [fallback] = accountMockHandlers({ baseUrl: apiUrl(''), now: () => new Date(ACCEPTED_AT) })
    .filter((handler) => handler.info.header.startsWith('PATCH'))
    .slice(0, 1);
  if (fallback === undefined) throw new Error('no PATCH handler in the account mocks');
  server.use(
    http.patch(apiUrl(ME_PATH), async ({ request }) => {
      const body = (await capture(request)).body as Record<string, unknown>;
      bodies.push(body);
      return respond === undefined ? undefined : respond(body);
    }),
    fallback,
  );
  return bodies;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  mockRouter.canGoBack.mockReturnValue(true);
  jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
  useToastStore.setState({ toast: null });
  useAuthStore.getState().clearSession();
  useAuthStore.getState().setLocale('en');
  useOnboardingStore.setState({ authWallSkipped: false, languageChosen: false });
  useProfileStore.setState({ profile: null, account: null, consents: null, onboarding: null });
  useThemeStore.getState().setTheme('system');
  useOrderStore.setState({ orders: {} });
  signIn();
});

afterAll(() => {
  useAuthStore.getState().clearSession();
});

describe('1. first launch: the language question', () => {
  it('is remembered across launches, and a v1 installation is asked once', () => {
    const engine = new InMemoryMmkv();
    engine.set(
      ONBOARDING_STORE_KEY,
      JSON.stringify({ state: { authWallSkipped: true }, version: 1 }),
    );
    const build = () => createOnboardingStore(mmkvStateStorage(engine));
    expect(build().getState()).toMatchObject({ authWallSkipped: true, languageChosen: false });

    build().getState().markLanguageChosen();

    expect(build().getState()).toMatchObject({ authWallSkipped: true, languageChosen: true });
  });

  it('asking for sign-in again does not ask for the language again', () => {
    useOnboardingStore.setState({ authWallSkipped: true, languageChosen: true });

    useOnboardingStore.getState().resetOnboarding();

    expect(useOnboardingStore.getState()).toMatchObject({
      authWallSkipped: false,
      languageChosen: true,
    });
  });

  it('saves Nepali, marks the question answered and moves on', () => {
    renderWithProviders(<LanguageScreen />);
    expect(screen.getByTestId('language-option-en')).toBeSelected();

    fireEvent.press(screen.getByTestId('language-option-ne'));
    // Nothing is saved until Continue.
    expect(useAuthStore.getState().locale).toBe('en');
    fireEvent.press(screen.getByTestId('language-continue'));

    expect(useAuthStore.getState().locale).toBe('ne');
    expect(useOnboardingStore.getState().languageChosen).toBe(true);
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });

  it('keeps English when Continue is pressed without choosing', () => {
    renderWithProviders(<LanguageScreen />);

    fireEvent.press(screen.getByTestId('language-continue'));

    expect(useAuthStore.getState().locale).toBe('en');
    expect(useOnboardingStore.getState().languageChosen).toBe(true);
  });
});

describe('1. language toggle and account sync', () => {
  it('a guest changes the language on the phone only: no request', async () => {
    useAuthStore.getState().clearSession();
    const bodies = servePatch();
    renderWithProviders(<LanguageToggle />);

    fireEvent.press(screen.getByTestId('language-toggle-ne'));

    expect(useAuthStore.getState().locale).toBe('ne');
    await Promise.resolve();
    expect(bodies).toEqual([]);
  });

  it('a signed-in customer’s change is copied to the account', async () => {
    const bodies = servePatch();
    renderWithProviders(<LanguageToggle />);

    fireEvent.press(screen.getByTestId('language-toggle-ne'));
    // Pressing the language already shown asks nothing.
    fireEvent.press(screen.getByTestId('language-toggle-ne'));

    await waitFor(() => {
      expect(bodies).toEqual([{ language_preference: 'ne' }]);
    });
    expect(screen.getByTestId('language-toggle-ne')).toBeSelected();
  });

  it('signing in sends the language chosen on this phone to the account', async () => {
    useAuthStore.getState().clearSession();
    useAuthStore.getState().setLocale('ne');
    const bodies = servePatch();
    server.use(http.post(apiUrl(OTP_VERIFY_PATH), () => HttpResponse.json(authTokensResponse())));
    mockParams = { phone: TEST_PHONE, resendAfter: '60' };
    renderWithProviders(<VerifyOtpScreen />);

    fireEvent.changeText(screen.getByTestId('otp-input'), '123456');
    fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(bodies).toEqual([{ language_preference: 'ne' }]);
    });
    // An existing account goes back to whoever asked for sign-in.
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(useProfileStore.getState().onboarding).toBeNull();
  });

  it('a server without the route yet is not an error (the choice stays on the phone)', async () => {
    server.use(
      http.patch(apiUrl(ME_PATH), () =>
        HttpResponse.json(
          { error: { code: 'NOT_FOUND', message: 'No such route' } },
          { status: 404 },
        ),
      ),
    );

    await expect(updateAccount({ language_preference: 'ne' })).resolves.toBeNull();
  });
});

describe('2. sign-in number field and keyboard', () => {
  it('caps a full field at ten natively, and leaves room for a pasted prefix before that', () => {
    expect(phoneInputMaxLength('')).toBeGreaterThanOrEqual('+977 98-0000 0001'.length);
    expect(phoneInputMaxLength('980000000')).toBeGreaterThan(10);
    expect(phoneInputMaxLength('9800000001')).toBe(10);
  });

  it('answers "no change" for a keystroke the field refuses', () => {
    expect(nextPhoneDraft('9800000001', '98000000019')).toBeNull();
    expect(nextPhoneDraft('9800', '9800a')).toBeNull();
    expect(nextPhoneDraft('9800', '98000')).toBe('98000');
    expect(nextPhoneDraft('', '+977 9800000001')).toBe('9800000001');
  });

  it('an eleventh keystroke changes nothing on screen, and the field is then capped at ten', () => {
    mockParams = {};
    renderWithProviders(<LoginScreen />);
    const field = () => screen.getByTestId('phone-input');

    fireEvent.changeText(field(), '9800000001');
    expect(field().props.maxLength).toBe(10);
    fireEvent.changeText(field(), '98000000015');

    expect(field().props.value).toBe('9800000001');
    expect(screen.queryByTestId('login-error')).toBeNull();
  });

  it.each([
    ['ios', 'padding'],
    ['android', 'height'],
  ] as const)('on %s the sign-in screens avoid the keyboard by %s', (os, behavior) => {
    const original = Platform.OS;
    Platform.OS = os;
    try {
      const login = renderWithProviders(<LoginScreen />);
      expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe(behavior);
      login.unmount();

      mockParams = { phone: TEST_PHONE, resendAfter: '60' };
      renderWithProviders(<VerifyOtpScreen />);
      expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe(behavior);
    } finally {
      Platform.OS = original;
    }
  });
});

describe('2. guest mode: nothing about favourites', () => {
  const [entry] = feedResponse().serviceable;
  if (entry === undefined) throw new Error('the feed fixture has no serviceable shop');
  const header = (
    <ShopHeader
      name="Thamel Kirana Pasal"
      palika="Kathmandu Metropolitan City"
      extras={NO_VENDOR_EXTRAS}
      distanceKm={1.2}
      serviceable
      favourite={false}
      onToggleFavourite={jest.fn()}
      search=""
      searchHints={['Search in this shop']}
      onSearchChange={jest.fn()}
      onBack={jest.fn()}
    />
  );

  it('a signed-in customer sees the heart on a shop card, on a shop page, and the Profile row', () => {
    const card = renderWithProviders(<VendorCard entry={entry} />);
    expect(screen.getByTestId(`vendor-favourite-${entry.vendor.id}`)).toBeOnTheScreen();
    card.unmount();

    const shop = renderWithProviders(header);
    expect(screen.getByTestId('shop-favourite')).toBeOnTheScreen();
    shop.unmount();

    renderWithProviders(<ProfileScreen />);
    expect(screen.getByTestId('menu-favourites')).toBeOnTheScreen();
  });

  it('a guest sees none of the three', () => {
    useAuthStore.getState().clearSession();

    const card = renderWithProviders(<VendorCard entry={entry} />);
    expect(screen.queryByTestId(`vendor-favourite-${entry.vendor.id}`)).toBeNull();
    card.unmount();

    const shop = renderWithProviders(header);
    expect(screen.queryByTestId('shop-favourite')).toBeNull();
    expect(screen.getByTestId('shop-back')).toBeOnTheScreen();
    shop.unmount();

    renderWithProviders(<ProfileScreen />);
    expect(screen.queryByTestId('menu-favourites')).toBeNull();
  });
});

describe('3. new account: mandatory profile and consents', () => {
  const fillName = () => {
    fireEvent.changeText(screen.getByTestId('profile-full-name'), 'Sita Gurung');
  };
  const save = () => {
    fireEvent.press(screen.getByTestId('profile-save'));
  };

  it('a sign-in that created the account goes to "Complete your profile", not back', async () => {
    useAuthStore.getState().clearSession();
    server.use(
      http.post(apiUrl(OTP_VERIFY_PATH), () =>
        HttpResponse.json({
          ...authTokensResponse(true),
          access_token: accessTokenFor('CUSTOMER', USER_ID),
        }),
      ),
    );
    mockParams = { phone: TEST_PHONE, resendAfter: '60' };
    renderWithProviders(<VerifyOtpScreen />);

    fireEvent.changeText(screen.getByTestId('otp-input'), '123456');
    fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/complete-profile');
    });
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(useProfileStore.getState().onboarding).toEqual({ user_id: USER_ID });
  });

  it('remembers a pending onboarding across launches, for that account', () => {
    const engine = new InMemoryMmkv();
    const build = () => createProfileStore(mmkvStateStorage(engine));

    build().getState().requireOnboarding(USER_ID);
    expect(build().getState().onboarding).toEqual({ user_id: USER_ID });

    build().getState().completeOnboarding();
    expect(build().getState().onboarding).toBeNull();
  });

  it('refuses to save without the Terms box, and says so; ticking it clears the message', async () => {
    const bodies = servePatch();
    renderWithProviders(<CompleteProfileScreen />);
    expect(screen.getByTestId('profile-terms')).not.toBeChecked();
    expect(screen.getByTestId('profile-whatsapp')).not.toBeChecked();

    fillName();
    save();

    expect(screen.getByTestId('profile-error-terms')).toHaveTextContent(
      'Please accept the Terms & Conditions and Privacy Policy to continue.',
    );
    await Promise.resolve();
    expect(bodies).toEqual([]);
    expect(useProfileStore.getState().profile).toBeNull();

    fireEvent.press(screen.getByTestId('profile-terms'));
    expect(screen.queryByTestId('profile-error-terms')).toBeNull();
  });

  it('labels the two boxes as asked', () => {
    renderWithProviders(<CompleteProfileScreen />);

    expect(
      screen.getByRole('checkbox', {
        name: 'I agree to the Terms & Conditions and Privacy Policy',
      }),
    ).toBeOnTheScreen();
    expect(screen.getByRole('checkbox', { name: 'Get updates on WhatsApp' })).toBeOnTheScreen();
  });

  it('creates the profile with the consents and ends the onboarding', async () => {
    useProfileStore.getState().requireOnboarding(USER_ID);
    useAuthStore.getState().setLocale('ne');
    const bodies = servePatch();
    renderWithProviders(<CompleteProfileScreen />);

    fillName();
    fireEvent.press(screen.getByTestId('profile-terms'));
    fireEvent.press(screen.getByTestId('profile-whatsapp'));
    save();

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
    // The device sends its agreement, never a timestamp: the server stamps the time.
    expect(bodies).toEqual([
      {
        full_name: 'Sita Gurung',
        email: null,
        language_preference: 'ne',
        accept_terms: true,
        whatsapp_opt_in: true,
      },
    ]);
    expect(useProfileStore.getState()).toMatchObject({
      profile: { full_name: 'Sita Gurung', email: null, user_id: USER_ID },
      consents: { user_id: USER_ID, terms_accepted_at: ACCEPTED_AT, whatsapp_opt_in: true },
      onboarding: null,
    });
  });

  it('WhatsApp updates are off unless the box is ticked', async () => {
    const bodies = servePatch();
    renderWithProviders(<CompleteProfileScreen />);

    fillName();
    fireEvent.press(screen.getByTestId('profile-terms'));
    save();

    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toMatchObject({ accept_terms: true, whatsapp_opt_in: false });
  });

  it('keeps the profile on the phone when the server has no profile route yet', async () => {
    useProfileStore.getState().requireOnboarding(USER_ID);
    servePatch(() =>
      HttpResponse.json(
        { error: { code: 'NOT_FOUND', message: 'No such route' } },
        { status: 404 },
      ),
    );
    renderWithProviders(<CompleteProfileScreen />);

    fillName();
    fireEvent.press(screen.getByTestId('profile-terms'));
    save();

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
    const { consents, onboarding, profile } = useProfileStore.getState();
    expect(profile?.full_name).toBe('Sita Gurung');
    expect(consents?.terms_accepted_at).toEqual(expect.any(String));
    expect(onboarding).toBeNull();
  });

  it('saves nothing, and stays, when the server cannot be reached', async () => {
    useProfileStore.getState().requireOnboarding(USER_ID);
    servePatch(() => HttpResponse.error());
    renderWithProviders(<CompleteProfileScreen />);

    fillName();
    fireEvent.press(screen.getByTestId('profile-terms'));
    save();

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        "Couldn't save your profile. Check your connection and try again.",
      );
    });
    expect(useProfileStore.getState()).toMatchObject({
      profile: null,
      consents: null,
      onboarding: { user_id: USER_ID },
    });
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(screen.getByTestId('profile-save')).toBeEnabled();
  });

  it('editing later shows no consent boxes and sends no consent', async () => {
    useProfileStore.getState().setProfile({ full_name: 'Sita Gurung', email: null }, USER_ID);
    useProfileStore
      .getState()
      .setConsents({ terms_accepted_at: ACCEPTED_AT, whatsapp_opt_in: true }, USER_ID);
    const bodies = servePatch();
    renderWithProviders(<CompleteProfileScreen />);
    expect(screen.queryByTestId('profile-consents')).toBeNull();

    fireEvent.changeText(screen.getByTestId('profile-email'), 'sita@example.com');
    save();

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
    expect(bodies).toEqual([
      { full_name: 'Sita Gurung', email: 'sita@example.com', language_preference: 'en' },
    ]);
    expect(useProfileStore.getState().consents).toEqual({
      user_id: USER_ID,
      terms_accepted_at: ACCEPTED_AT,
      whatsapp_opt_in: true,
    });
  });

  it('another account on this phone is asked for its own consent', () => {
    useProfileStore
      .getState()
      .setConsents({ terms_accepted_at: ACCEPTED_AT, whatsapp_opt_in: true }, 'another-user-id');

    renderWithProviders(<CompleteProfileScreen />);

    expect(screen.getByTestId('profile-terms')).not.toBeChecked();
    expect(screen.getByTestId('profile-whatsapp')).not.toBeChecked();
  });

  it('opens the two documents from the consent text', () => {
    renderWithProviders(<CompleteProfileScreen />);

    fireEvent.press(screen.getByTestId('profile-terms-link'));
    fireEvent.press(screen.getByTestId('profile-privacy-link'));

    expect(mockRouter.push.mock.calls).toEqual([
      [{ pathname: '/legal/[doc]', params: { doc: 'terms' } }],
      [{ pathname: '/legal/[doc]', params: { doc: 'privacy' } }],
    ]);
  });
});

describe('the mock account API (src/mocks)', () => {
  it('stamps the terms once, lower-cases the email, and refuses a withdrawn agreement', async () => {
    let clock = ACCEPTED_AT;
    server.use(...accountMockHandlers({ baseUrl: apiUrl(''), now: () => new Date(clock) }));

    const first = await updateAccount({ accept_terms: true, email: 'Sita@Example.com' });
    clock = '2027-01-01T00:00:00.000Z';
    const second = await updateAccount({ accept_terms: true, whatsapp_opt_in: true });

    expect(first).toMatchObject({ terms_accepted_at: ACCEPTED_AT, email: 'sita@example.com' });
    expect(second).toMatchObject({ terms_accepted_at: ACCEPTED_AT, whatsapp_opt_in: true });
    await expect(updateAccount({ accept_terms: false as unknown as true })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('counts the open orders this phone tracks (what the device mock answers with)', () => {
    const { trackPlaced, setState } = useOrderStore.getState();
    trackPlaced({ orderId: 'order-a', paymentMethod: 'COD', totalNpr: 500 }, 1_000);
    trackPlaced({ orderId: 'order-b', paymentMethod: 'COD', totalNpr: 500 }, 2_000);
    trackPlaced({ orderId: 'order-c', paymentMethod: 'COD', totalNpr: 500 }, 3_000);
    setState('order-b', 'DELIVERED');
    setState('order-c', 'CANCELED');

    expect(openOrderCount()).toBe(1);
  });
});

describe('4. Profile tab', () => {
  it('ends with the version footer', () => {
    renderWithProviders(<ProfileScreen />);

    expect(screen.getByTestId('app-footer')).toHaveTextContent('Hamro Pasal v1.0.0');
  });

  it('opens Appearance, Notification Preferences, About Us and Account Privacy', () => {
    renderWithProviders(<ProfileScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Appearance' }));
    fireEvent.press(screen.getByRole('button', { name: 'Notification Preferences' }));
    fireEvent.press(screen.getByRole('button', { name: 'About Us' }));
    fireEvent.press(screen.getByRole('button', { name: 'Account Privacy' }));

    expect(mockRouter.push.mock.calls).toEqual([
      ['/settings/appearance'],
      ['/settings/notifications'],
      ['/settings/about'],
      ['/settings/privacy'],
    ]);
  });

  it('offers a guest the device settings only', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<ProfileScreen />);

    expect(screen.getByTestId('menu-appearance')).toBeOnTheScreen();
    expect(screen.getByTestId('menu-about')).toBeOnTheScreen();
    expect(screen.getByTestId('app-footer')).toBeOnTheScreen();
    expect(screen.queryByTestId('menu-notifications')).toBeNull();
    expect(screen.queryByTestId('menu-account-privacy')).toBeNull();
  });

  it('shows the current theme on the Appearance row', () => {
    useThemeStore.getState().setTheme('dark');
    renderWithProviders(<ProfileScreen />);

    expect(screen.getByTestId('menu-appearance')).toHaveTextContent('AppearanceDark');
  });
});

describe('4. Appearance', () => {
  it('offers Light, Dark and System, and saves the one chosen', () => {
    renderWithProviders(<AppearanceScreen />);
    expect(screen.getByRole('radio', { name: 'System Theme' })).toBeSelected();

    fireEvent.press(screen.getByRole('radio', { name: 'Dark Theme' }));

    expect(useThemeStore.getState().theme).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark Theme' })).toBeSelected();
    expect(screen.getByRole('radio', { name: 'System Theme' })).not.toBeSelected();

    fireEvent.press(screen.getByRole('radio', { name: 'Light Theme' }));
    expect(useThemeStore.getState().theme).toBe('light');
  });
});

describe('4. Notification Preferences', () => {
  const toggle = () => screen.getByTestId('whatsapp-opt-in-switch');

  beforeEach(() => {
    useProfileStore
      .getState()
      .setConsents({ terms_accepted_at: ACCEPTED_AT, whatsapp_opt_in: false }, USER_ID);
  });

  it('switches WhatsApp updates on for the account, keeping the terms time', async () => {
    const bodies = servePatch();
    renderWithProviders(<NotificationPreferencesScreen />);
    expect(toggle().props.value).toBe(false);

    fireEvent(toggle(), 'valueChange', true);

    expect(toggle().props.value).toBe(true);
    await waitFor(() => {
      expect(bodies).toEqual([{ whatsapp_opt_in: true }]);
    });
    await waitFor(() => {
      expect(toggle()).toBeEnabled();
    });
    expect(useProfileStore.getState().consents).toEqual({
      user_id: USER_ID,
      terms_accepted_at: ACCEPTED_AT,
      whatsapp_opt_in: true,
    });
  });

  it('moves the switch back and says so when the change cannot be saved', async () => {
    servePatch(() => HttpResponse.error());
    renderWithProviders(<NotificationPreferencesScreen />);

    fireEvent(toggle(), 'valueChange', true);

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        "Couldn't save your choice. Please try again.",
      );
    });
    expect(toggle().props.value).toBe(false);
    expect(useProfileStore.getState().consents?.whatsapp_opt_in).toBe(false);
  });

  it('is not for guests', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<NotificationPreferencesScreen />);

    expect(screen.getByText('redirect:/login')).toBeOnTheScreen();
  });
});

describe('4. About Us', () => {
  it('describes the app and links both legal documents', () => {
    renderWithProviders(<AboutScreen />);
    expect(screen.getByText('Version 1.0.0')).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Privacy Policy' }));
    fireEvent.press(screen.getByRole('button', { name: 'Terms & Conditions' }));

    expect(mockRouter.push.mock.calls).toEqual([
      [{ pathname: '/legal/[doc]', params: { doc: 'privacy' } }],
      [{ pathname: '/legal/[doc]', params: { doc: 'terms' } }],
    ]);
  });
});

describe('4. Account Privacy: delete account', () => {
  const PENDING =
    'You have pending orders. Please complete or cancel them before deleting your account.';
  let alert: jest.SpiedFunction<typeof Alert.alert>;

  /** Serves both deletion routes; returns what was asked, in order. */
  function serveDeletion(pending: () => number) {
    const asked: string[] = [];
    const record = (path: string) =>
      http.all(apiUrl(path), ({ request }) => {
        asked.push(`${request.method} ${path}`);
      });
    server.use(
      record(DELETION_ELIGIBILITY_PATH),
      record(DELETION_REQUEST_PATH),
      ...accountMockHandlers({ baseUrl: apiUrl(''), pendingOrderCount: pending }),
    );
    return asked;
  }

  /** Presses the button of the confirmation alert with this label. */
  function pressAlertButton(label: string): void {
    const buttons = alert.mock.calls.at(-1)?.[2];
    const button = buttons?.find((candidate) => candidate.text === label);
    if (button === undefined) throw new Error(`the alert has no "${label}" button`);
    button.onPress?.();
  }

  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    useProfileStore.getState().setProfile({ full_name: 'Sita Gurung', email: null }, USER_ID);
    useFavouritesStore
      .getState()
      .toggleFavourite({ vendorId: 'shop-1', name: 'Thamel Kirana Pasal', location: 'Thamel' });
  });
  afterEach(() => {
    alert.mockRestore();
  });

  it('refuses while an order is open, with the reason, and sends no deletion request', async () => {
    const asked = serveDeletion(() => 2);
    renderWithProviders(<AccountPrivacyScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Delete Account' }));

    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith('Pending orders', PENDING);
    });
    expect(asked).toEqual([`GET ${DELETION_ELIGIBILITY_PATH}`]);
    expect(useAuthStore.getState().refreshToken).not.toBeNull();
  });

  it('asks for confirmation when eligible; Cancel deletes nothing', async () => {
    const asked = serveDeletion(() => 0);
    renderWithProviders(<AccountPrivacyScreen />);

    fireEvent.press(screen.getByTestId('delete-account'));

    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith(
        'Delete your account?',
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ text: 'Cancel', style: 'cancel' }),
          expect.objectContaining({ text: 'Delete Account', style: 'destructive' }),
        ]),
      );
    });
    pressAlertButton('Cancel');

    expect(asked).toEqual([`GET ${DELETION_ELIGIBILITY_PATH}`]);
    expect(useProfileStore.getState().profile).not.toBeNull();
  });

  it('once confirmed, requests the soft delete, signs out and forgets the account’s data', async () => {
    const asked = serveDeletion(() => 0);
    renderWithProviders(<AccountPrivacyScreen />);

    fireEvent.press(screen.getByTestId('delete-account'));
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });
    pressAlertButton('Delete Account');

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    expect(asked).toEqual([`GET ${DELETION_ELIGIBILITY_PATH}`, `POST ${DELETION_REQUEST_PATH}`]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(useProfileStore.getState()).toMatchObject({ profile: null, consents: null });
    expect(useAddressStore.getState().addresses).toEqual([]);
    expect(useFavouritesStore.getState().favourites).toEqual({});
    expect(useToastStore.getState().toast?.message).toBe(
      'Your account deletion request was received.',
    );
  });

  it('keeps the device preferences (language, theme, the answered questions)', async () => {
    useAuthStore.getState().setLocale('ne');
    useThemeStore.getState().setTheme('dark');
    useOnboardingStore.setState({ authWallSkipped: true, languageChosen: true });
    serveDeletion(() => 0);
    renderWithProviders(<AccountPrivacyScreen />);

    fireEvent.press(screen.getByTestId('delete-account'));
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });
    pressAlertButton('Delete Account');
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });

    expect(useAuthStore.getState().locale).toBe('ne');
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(useOnboardingStore.getState()).toMatchObject({
      authWallSkipped: true,
      languageChosen: true,
    });
  });

  it('an order placed between the check and the request still blocks the deletion', async () => {
    let pending = 0;
    serveDeletion(() => pending);
    renderWithProviders(<AccountPrivacyScreen />);

    fireEvent.press(screen.getByTestId('delete-account'));
    await waitFor(() => {
      expect(alert).toHaveBeenCalledTimes(1);
    });
    pending = 1;
    pressAlertButton('Delete Account');

    await waitFor(() => {
      expect(alert).toHaveBeenLastCalledWith('Pending orders', PENDING);
    });
    expect(useAuthStore.getState().refreshToken).not.toBeNull();
    expect(useProfileStore.getState().profile).not.toBeNull();
  });

  it('deletes nothing when the server cannot be asked', async () => {
    server.use(http.get(apiUrl(DELETION_ELIGIBILITY_PATH), () => HttpResponse.error()));
    renderWithProviders(<AccountPrivacyScreen />);

    fireEvent.press(screen.getByTestId('delete-account'));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        "Couldn't reach the server. Please try again.",
      );
    });
    expect(alert).not.toHaveBeenCalled();
    expect(useAuthStore.getState().refreshToken).not.toBeNull();
  });
});

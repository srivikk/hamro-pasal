import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import LoginScreen from '../../../app/login';
import VerifyOtpScreen from '../../../app/verify-otp';
import { OTP_SEND_PATH, OTP_VERIFY_PATH } from '../../api/auth';
import { VENDORS_PATH } from '../../api/catalog';
import { setAppVariantForTests } from '../../lib/app-variant';
import { useAuthStore } from '../../store/useAuthStore';
import { useSellerSignupStore } from '../../store/useSellerSignupStore';
import { useCartStore } from '../../store/useCartStore';
import { useToastStore } from '../../store/useToastStore';
import {
  authTokensResponse,
  errorBody,
  feedResponse,
  ISSUED_ACCESS_TOKEN,
  ISSUED_REFRESH_TOKEN,
  NOODLES,
  otpSendResponse,
  TEST_PHONE,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, capture, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: () => null,
  useLocalSearchParams: () => mockParams,
}));
const mockRouter = jest.mocked(router);

setupApiTestEnvironment();

/** Records every POST to `path` and answers with `respond()`. */
function servePost(path: string, respond: () => Response) {
  const bodies: unknown[] = [];
  server.use(
    http.post(apiUrl(path), async ({ request }) => {
      bodies.push((await capture(request)).body);
      return respond();
    }),
  );
  return bodies;
}

const typePhone = (text: string) => {
  fireEvent.changeText(screen.getByTestId('phone-input'), text);
};
const typeCode = (text: string) => {
  fireEvent.changeText(screen.getByTestId('otp-input'), text);
};

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.getState().clearSession();
  useToastStore.setState({ toast: null });
  mockParams = { phone: TEST_PHONE, resendAfter: '60' };
  mockRouter.canGoBack.mockReturnValue(true);
});

describe('Login screen (POST /api/auth/otp/send)', () => {
  it('sends the code to the +977 number and moves on to the code screen', async () => {
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<LoginScreen />);

    typePhone('9800000001');
    fireEvent.press(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith({
        pathname: '/verify-otp',
        params: { phone: TEST_PHONE, resendAfter: '60' },
      });
    });
    expect(sent).toEqual([{ phone: TEST_PHONE }]);
  });

  it('accepts a number typed with Nepali digits', async () => {
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<LoginScreen />, { locale: 'ne' });

    typePhone('९८०००००००१');
    fireEvent.press(screen.getByRole('button', { name: 'कोड पठाउनुहोस्' }));

    await waitFor(() => {
      expect(sent).toEqual([{ phone: TEST_PHONE }]);
    });
  });

  it('refuses numbers that fail the shared +977 regex without calling the API', () => {
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<LoginScreen />);

    typePhone('8800000001');
    fireEvent.press(screen.getByRole('button', { name: 'Send code' }));

    expect(screen.getByTestId('login-error')).toHaveTextContent(
      'Enter a 10-digit Nepal mobile number starting with 9.',
    );
    expect(sent).toEqual([]);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('explains the resend cooldown', async () => {
    servePost(OTP_SEND_PATH, () =>
      HttpResponse.json(errorBody('OTP_RESEND_COOLDOWN', { retry_after_seconds: 42 }), {
        status: 429,
      }),
    );
    renderWithProviders(<LoginScreen />);

    typePhone('9800000001');
    fireEvent.press(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      'Please wait 42 s before requesting another code.',
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

describe('Code screen (POST /api/auth/otp/verify)', () => {
  it('in the Seller app, takes a number without a shop to the signup with its token (step 7.7)', async () => {
    setAppVariantForTests('SELLER');
    try {
      const verified = servePost(OTP_VERIFY_PATH, () =>
        HttpResponse.json(
          errorBody('ROLE_NOT_GRANTED', {
            role: 'VENDOR',
            signup_token: 'signup-token-1',
            signup_token_expires_in: 1800,
          }),
          { status: 403 },
        ),
      );
      renderWithProviders(<VerifyOtpScreen />);
      typeCode('042187');
      fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

      await waitFor(() => {
        expect(mockRouter.replace).toHaveBeenCalledWith('/seller-signup');
      });
      expect(verified).toEqual([{ phone: TEST_PHONE, code: '042187', app: 'SELLER' }]);
      expect(useSellerSignupStore.getState()).toMatchObject({
        phone: TEST_PHONE,
        token: 'signup-token-1',
      });
      expect(useAuthStore.getState().refreshToken).toBeNull();
    } finally {
      setAppVariantForTests('CUSTOMER');
    }
  });

  it('stores the session and returns to the previous screen', async () => {
    const verified = servePost(OTP_VERIFY_PATH, () => HttpResponse.json(authTokensResponse()));
    renderWithProviders(<VerifyOtpScreen />);

    expect(screen.getByText('Sent to +977 9800000001')).toBeOnTheScreen();
    typeCode('042187');
    fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalledTimes(1);
    });
    expect(verified).toEqual([{ phone: TEST_PHONE, code: '042187', app: 'CUSTOMER' }]);
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: ISSUED_ACCESS_TOKEN,
      refreshToken: ISSUED_REFRESH_TOKEN,
    });
    expect(useToastStore.getState().toast).toMatchObject({ message: "You're signed in." });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('opens the Feed when sign-in was the first screen', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    servePost(OTP_VERIFY_PATH, () => HttpResponse.json(authTokensResponse()));
    renderWithProviders(<VerifyOtpScreen />);

    typeCode('042187');
    fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('keeps Verify disabled until 6 digits are entered', () => {
    renderWithProviders(<VerifyOtpScreen />);

    typeCode('04218');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
    typeCode('042187');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
  });

  it.each([
    ['OTP_INVALID', 401, { attempts_remaining: 4 }, 'Wrong code. Attempts left: 4.'],
    ['OTP_EXPIRED', 410, undefined, 'This code has expired. Request a new one.'],
    ['OTP_ATTEMPTS_EXCEEDED', 429, undefined, 'Too many wrong attempts. Request a new code.'],
  ] as const)('explains %s and stays signed out', async (code, status, details, message) => {
    servePost(OTP_VERIFY_PATH, () => HttpResponse.json(errorBody(code, details), { status }));
    renderWithProviders(<VerifyOtpScreen />);

    typeCode('000000');
    fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByTestId('otp-error')).toHaveTextContent(message);
    expect(screen.getByTestId('otp-input').props.value).toBe('');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('shows a resend countdown instead of the resend button while the cooldown runs', () => {
    renderWithProviders(<VerifyOtpScreen />);
    expect(screen.getByTestId('resend-countdown')).toHaveTextContent(
      'You can request a new code in 01:00',
    );
    expect(screen.queryByRole('button', { name: 'Resend code' })).toBeNull();
  });

  it('resends a code once the cooldown is over', async () => {
    mockParams = { phone: TEST_PHONE, resendAfter: '0' };
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<VerifyOtpScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Resend code' }));

    await waitFor(() => {
      expect(useToastStore.getState().toast).toMatchObject({
        message: 'A new code is on its way.',
      });
    });
    expect(sent).toEqual([{ phone: TEST_PHONE }]);
    expect(await screen.findByTestId('resend-countdown')).toBeOnTheScreen();
  });

  it('lets the customer change the number', () => {
    renderWithProviders(<VerifyOtpScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Change number' }));

    expect(mockRouter.replace).toHaveBeenCalledWith('/login');
  });
});

describe('a guest signing in', () => {
  it('shows the Feed before sign-in, and keeps the guest cart once the code is verified', async () => {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
    servePost(OTP_VERIFY_PATH, () => HttpResponse.json(authTokensResponse()));
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
    const guestCart = {
      vendor: useCartStore.getState().vendor,
      lines: useCartStore.getState().lines,
    };
    // The Feed and the code screen share one QueryClient, as they do inside the app.
    renderWithProviders(
      <>
        <FeedScreen />
        <VerifyOtpScreen />
      </>,
    );

    // Signed out, and the shops are already there.
    expect(await screen.findByTestId(`vendor-card-${THAMEL_VENDOR.id}`)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

    typeCode('042187');
    fireEvent.press(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBe(ISSUED_ACCESS_TOKEN);
    });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(guestCart.lines).toHaveLength(1);
    expect(useCartStore.getState().vendor).toEqual(guestCart.vendor);
    expect(useCartStore.getState().lines).toEqual(guestCart.lines);
  });
});

describe('Login screen as registration (mode=signup)', () => {
  it('words the screen for a new customer and sends the same OTP request', async () => {
    mockParams = { mode: 'signup' };
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<LoginScreen />);

    expect(screen.getByText('Create your account')).toBeOnTheScreen();
    expect(screen.queryByTestId('login-new-here')).toBeNull();
    typePhone('9800000001');
    fireEvent.press(screen.getByRole('button', { name: 'Send code' }));

    await waitFor(() => {
      expect(sent).toEqual([{ phone: TEST_PHONE }]);
    });
  });

  it('tells a new customer on the plain sign-in screen that the code creates the account', () => {
    mockParams = {};
    renderWithProviders(<LoginScreen />);

    expect(screen.getByText('Sign in')).toBeOnTheScreen();
    expect(screen.getByTestId('login-new-here')).toBeOnTheScreen();
  });
});

describe('Login screen: the ten-digit number field', () => {
  it('accepts a pasted or auto-filled +977 number by taking the prefix off', async () => {
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<LoginScreen />);
    // A field that is not full leaves room for the prefix: the OS must not cut a paste short.
    expect(screen.getByTestId('phone-input').props.maxLength).toBeGreaterThanOrEqual(15);

    typePhone('+977 9800000001');

    expect(screen.getByTestId('phone-input').props.value).toBe('9800000001');
    fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => {
      expect(sent).toEqual([{ phone: '+9779800000001' }]);
    });
  });

  it('never shows an eleventh digit, and drops anything that is not a digit', () => {
    renderWithProviders(<LoginScreen />);

    typePhone('98000000019999');
    expect(screen.getByTestId('phone-input').props.value).toBe('9800000001');

    typePhone('98-00 ab');
    expect(screen.getByTestId('phone-input').props.value).toBe('9800');
  });

  it('sends nothing for fewer than ten digits', () => {
    const sent = servePost(OTP_SEND_PATH, () => HttpResponse.json(otpSendResponse()));
    renderWithProviders(<LoginScreen />);

    typePhone('980000000');
    fireEvent.press(screen.getByRole('button', { name: 'Send code' }));

    expect(screen.getByTestId('login-error')).toHaveTextContent(
      'Enter a 10-digit Nepal mobile number starting with 9.',
    );
    expect(sent).toEqual([]);
  });
});

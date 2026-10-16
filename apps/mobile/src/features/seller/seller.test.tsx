import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import type * as ReactNativeModule from 'react-native';

import SellerSignupScreen from '../../../app/seller-signup';
import { ApiError } from '../../api/http';
import { SELLER_APP_SIGNUP_URL, SELLER_APP_STORE_URL } from '../../lib/app-variant';
import { useAuthStore } from '../../store/useAuthStore';
import { useSellerSignupStore } from '../../store/useSellerSignupStore';
import { useToastStore } from '../../store/useToastStore';
import { accessTokenFor } from '../../test/access-tokens';
import { mockWebView } from '../../test/mock-webview';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { openSellerSignup } from './become-seller';
import { SELLER_SIGNUP_PATH, signupTokenOf } from './seller-api';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: ({ href }: { href: string }) => {
    const { Text } = jest.requireActual<typeof ReactNativeModule>('react-native');
    return <Text testID="redirect">{href}</Text>;
  },
}));
const mockRouter = jest.mocked(router);

setupApiTestEnvironment();

const VENDOR_USER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';

function application() {
  return {
    vendor_id: '6f1c2a10-0000-4000-8000-000000000011',
    vendor_code: 'HPV-00042',
    business_name: 'Thamel Kirana Pasal',
    status: 'SANDBOXED',
    pan_document_uploaded: false,
    citizenship_document_uploaded: false,
    tax_id_saved: false,
    ready_for_review: false,
    created_at: '2026-10-16T08:00:00.000Z',
  };
}

/** Drops the map's pin in Thamel and confirms it, as the WebView would report it. */
function pinThamel(): void {
  fireEvent.press(screen.getByRole('button', { name: 'Pin the shop on the map' }));
  const onMessage = mockWebView.props?.onMessage;
  if (onMessage === undefined) throw new Error('No map WebView');
  act(() => {
    onMessage({
      nativeEvent: { data: JSON.stringify({ type: 'center', lat: 27.7154, lng: 85.3123 }) },
    } as Parameters<typeof onMessage>[0]);
  });
  fireEvent.press(screen.getByRole('button', { name: 'Use this location' }));
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({ accessToken: null, refreshToken: null, role: null });
  useSellerSignupStore.getState().clear();
  useToastStore.setState({ toast: null });
});

describe('Seller signup (step 7.7)', () => {
  it('sends the shop with the signup token and continues signed in as its vendor', async () => {
    useSellerSignupStore.getState().start('+9779800000001', 'signup-token-1', 1800);
    const sent: unknown[] = [];
    server.use(
      http.post(apiUrl(SELLER_SIGNUP_PATH), async ({ request }) => {
        sent.push(await request.json());
        return HttpResponse.json(
          {
            token_type: 'Bearer',
            access_token: accessTokenFor('VENDOR', VENDOR_USER),
            access_token_expires_in: 900,
            refresh_token: 'refresh-vendor',
            refresh_token_expires_in: 604_800,
            user: {
              id: VENDOR_USER,
              role: 'VENDOR',
              first_name: null,
              roles: ['CUSTOMER', 'VENDOR'],
            },
            is_new_user: false,
            application: application(),
          },
          { status: 201 },
        );
      }),
    );
    renderWithProviders(<SellerSignupScreen />);

    // Nothing is sent until the shop has a name, a Palika and a location.
    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));
    expect(screen.getByText('Enter your shop’s name.')).toBeOnTheScreen();
    expect(screen.getByText('Pin where your shop is.')).toBeOnTheScreen();

    fireEvent.changeText(
      screen.getByTestId('seller-signup-business-name'),
      ' Thamel Kirana Pasal ',
    );
    fireEvent.changeText(screen.getByTestId('seller-signup-palika'), 'Kathmandu Metropolitan City');
    pinThamel();
    fireEvent.press(screen.getByTestId('seller-signup-PLATFORM_FLEET'));
    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/seller-application');
    });
    expect(sent).toEqual([
      {
        signup_token: 'signup-token-1',
        business_name: 'Thamel Kirana Pasal',
        municipality_palika_string: 'Kathmandu Metropolitan City',
        location: { lat: 27.7154, lng: 85.3123 },
        fulfillment_mode: 'PLATFORM_FLEET',
        delivery_scope: 'RADIUS_BOUND',
        radius_km: 3,
      },
    ]);
    expect(useAuthStore.getState()).toMatchObject({
      role: 'VENDOR',
      refreshToken: 'refresh-vendor',
    });
    expect(useSellerSignupStore.getState().token).toBeNull();
  });

  it('sends a phone without a fresh sign-in back to sign in', () => {
    renderWithProviders(<SellerSignupScreen />);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/login');
  });

  it('asks to sign in again when the signup token has run out', async () => {
    useSellerSignupStore.getState().start('+9779800000001', 'stale-token', 1800);
    server.use(
      http.post(apiUrl(SELLER_SIGNUP_PATH), () =>
        HttpResponse.json(
          { error: { code: 'INVALID_SIGNUP_TOKEN', message: 'x' } },
          { status: 401 },
        ),
      ),
    );
    renderWithProviders(<SellerSignupScreen />);
    fireEvent.changeText(screen.getByTestId('seller-signup-business-name'), 'Thamel Kirana Pasal');
    fireEvent.changeText(screen.getByTestId('seller-signup-palika'), 'Kathmandu Metropolitan City');
    pinThamel();
    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/login');
    });
    expect(useToastStore.getState().toast?.message).toBe(
      'Your sign-in expired. Sign in again to continue.',
    );
  });
});

describe('the Seller app sign-in of a number without a shop', () => {
  it('reads the signup token from 403 ROLE_NOT_GRANTED, and nothing from other errors', () => {
    expect(
      signupTokenOf(
        new ApiError(403, 'ROLE_NOT_GRANTED', 'x', {
          role: 'VENDOR',
          signup_token: 'tok',
          signup_token_expires_in: 1800,
        }),
      ),
    ).toEqual({ token: 'tok', expiresInSeconds: 1800 });
    expect(signupTokenOf(new ApiError(410, 'OTP_EXPIRED', 'x'))).toBeNull();
    expect(signupTokenOf(new Error('x'))).toBeNull();
  });
});

describe('Become a Seller (customer app)', () => {
  it('opens the Seller app’s signup when installed, else its store page', async () => {
    const opened: string[] = [];
    await expect(
      openSellerSignup((url) => {
        opened.push(url);
        return Promise.resolve();
      }),
    ).resolves.toBe('APP');
    expect(opened).toEqual([SELLER_APP_SIGNUP_URL]);

    const fallback: string[] = [];
    await expect(
      openSellerSignup((url) => {
        fallback.push(url);
        return url === SELLER_APP_SIGNUP_URL
          ? Promise.reject(new Error('no app'))
          : Promise.resolve();
      }),
    ).resolves.toBe('STORE');
    expect(fallback).toEqual([SELLER_APP_SIGNUP_URL, SELLER_APP_STORE_URL]);
  });
});

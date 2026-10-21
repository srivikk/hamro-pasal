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
import { SIGNUP_SUBSCRIPTION_PLANS, apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { openSellerSignup } from './become-seller';
import { SELLER_SIGNUP_OPTIONS_PATH, SELLER_SIGNUP_PATH, signupTokenOf } from './seller-api';
import { effectiveDeliveryMode, offeredDeliveryModes } from './signup-options';

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
    // The form appears once the delivery options are in.
    await screen.findByTestId('seller-signup-business-name');

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
    // The cheapest Subscription plan is chosen until the vendor picks another (2026-10-21).
    expect(screen.getByText('Rs. 999 a month, no commission')).toBeOnTheScreen();
    fireEvent.press(screen.getByTestId(`seller-signup-plan-${SIGNUP_SUBSCRIPTION_PLANS[1].id}`));
    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/seller-application');
    });
    expect(sent).toEqual([
      {
        signup_token: 'signup-token-1',
        pricing_plan_id: SIGNUP_SUBSCRIPTION_PLANS[1].id,
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
    // The form appears once the delivery options are in.
    await screen.findByTestId('seller-signup-business-name');
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

describe('delivery choices follow the platform switches (2026-10-20)', () => {
  const serveOptions = (self: boolean, fleet: boolean) => {
    server.use(
      http.get(apiUrl(SELLER_SIGNUP_OPTIONS_PATH), () =>
        HttpResponse.json({
          self_delivery_enabled: self,
          platform_fleet_enabled: fleet,
          signups_open: self || fleet,
          subscription_plans: SIGNUP_SUBSCRIPTION_PLANS,
        }),
      ),
    );
  };
  const fillIn = () => {
    fireEvent.changeText(screen.getByTestId('seller-signup-business-name'), 'Thamel Kirana Pasal');
    fireEvent.changeText(screen.getByTestId('seller-signup-palika'), 'Kathmandu Metropolitan City');
    pinThamel();
  };

  beforeEach(() => {
    useSellerSignupStore.getState().start('+9779800000001', 'signup-token-1', 1800);
  });

  it('offers only the modes that are switched on, and sends the one that is', async () => {
    serveOptions(false, true);
    const sent: { fulfillment_mode?: string }[] = [];
    server.use(
      http.post(apiUrl(SELLER_SIGNUP_PATH), async ({ request }) => {
        sent.push((await request.json()) as { fulfillment_mode?: string });
        return HttpResponse.json({ error: { code: 'STOP', message: 'x' } }, { status: 500 });
      }),
    );
    renderWithProviders(<SellerSignupScreen />);

    expect(await screen.findByTestId('seller-signup-PLATFORM_FLEET')).toBeSelected();
    expect(screen.queryByTestId('seller-signup-SELF_DELIVERY')).toBeNull();

    fillIn();
    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.fulfillment_mode).toBe('PLATFORM_FLEET');
  });

  it('hides the riders when only they are off', async () => {
    serveOptions(true, false);
    renderWithProviders(<SellerSignupScreen />);

    expect(await screen.findByTestId('seller-signup-SELF_DELIVERY')).toBeSelected();
    expect(screen.queryByTestId('seller-signup-PLATFORM_FLEET')).toBeNull();
  });

  it('says registrations are paused, with no form, when both are off', async () => {
    serveOptions(false, false);
    renderWithProviders(<SellerSignupScreen />);

    const paused = await screen.findByTestId('seller-signup-paused');
    expect(paused).toHaveTextContent(/New shop registrations are currently paused\./);
    expect(screen.queryByTestId('seller-signup-business-name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create my shop' })).toBeNull();
  });

  it('shows what is offered now when the server refuses a mode switched off meanwhile', async () => {
    let selfOn = true;
    server.use(
      http.get(apiUrl(SELLER_SIGNUP_OPTIONS_PATH), () =>
        HttpResponse.json({
          self_delivery_enabled: selfOn,
          platform_fleet_enabled: true,
          signups_open: true,
          subscription_plans: SIGNUP_SUBSCRIPTION_PLANS,
        }),
      ),
      http.post(apiUrl(SELLER_SIGNUP_PATH), () => {
        // The admin switched self delivery off after the screen opened.
        selfOn = false;
        return HttpResponse.json(
          {
            error: {
              code: 'DELIVERY_MODE_DISABLED',
              message: 'x',
              details: { fulfillment_mode: 'SELF_DELIVERY' },
            },
          },
          { status: 422 },
        );
      }),
    );
    renderWithProviders(<SellerSignupScreen />);
    fireEvent.press(await screen.findByTestId('seller-signup-SELF_DELIVERY'));
    fillIn();

    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));

    await waitFor(() => {
      expect(screen.queryByTestId('seller-signup-SELF_DELIVERY')).toBeNull();
    });
    expect(screen.getByTestId('seller-signup-PLATFORM_FLEET')).toBeSelected();
    expect(useToastStore.getState().toast?.message).toBe(
      'That delivery option was just switched off. Choose another and try again.',
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('turns into the paused notice when the server says registrations were paused meanwhile', async () => {
    let open = true;
    server.use(
      http.get(apiUrl(SELLER_SIGNUP_OPTIONS_PATH), () =>
        HttpResponse.json({
          self_delivery_enabled: open,
          platform_fleet_enabled: open,
          signups_open: open,
          subscription_plans: SIGNUP_SUBSCRIPTION_PLANS,
        }),
      ),
      http.post(apiUrl(SELLER_SIGNUP_PATH), () => {
        open = false;
        return HttpResponse.json(
          { error: { code: 'SELLER_SIGNUPS_PAUSED', message: 'x' } },
          { status: 409 },
        );
      }),
    );
    renderWithProviders(<SellerSignupScreen />);
    await screen.findByTestId('seller-signup-business-name');
    fillIn();

    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));

    expect(await screen.findByTestId('seller-signup-paused')).toBeOnTheScreen();
  });
});

describe('offered delivery modes', () => {
  it('lists the switched-on modes in order, and keeps a choice only while it is offered', () => {
    const both = {
      self_delivery_enabled: true,
      platform_fleet_enabled: true,
      signups_open: true,
      subscription_plans: [],
    };
    expect(offeredDeliveryModes(both)).toEqual(['SELF_DELIVERY', 'PLATFORM_FLEET']);
    expect(offeredDeliveryModes({ ...both, self_delivery_enabled: false })).toEqual([
      'PLATFORM_FLEET',
    ]);
    expect(
      offeredDeliveryModes({
        self_delivery_enabled: false,
        platform_fleet_enabled: false,
        signups_open: false,
        subscription_plans: [],
      }),
    ).toEqual([]);

    expect(effectiveDeliveryMode(['SELF_DELIVERY', 'PLATFORM_FLEET'], 'PLATFORM_FLEET')).toBe(
      'PLATFORM_FLEET',
    );
    expect(effectiveDeliveryMode(['PLATFORM_FLEET'], 'SELF_DELIVERY')).toBe('PLATFORM_FLEET');
    expect(effectiveDeliveryMode(['SELF_DELIVERY'], null)).toBe('SELF_DELIVERY');
    expect(effectiveDeliveryMode([], 'SELF_DELIVERY')).toBeNull();
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

describe('the plan a new shop chooses (2026-10-21)', () => {
  beforeEach(() => {
    useSellerSignupStore.getState().start('+9779800000001', 'signup-token-1', 1800);
  });

  it('is paused when no Subscription plan is on offer', async () => {
    server.use(
      http.get(apiUrl(SELLER_SIGNUP_OPTIONS_PATH), () =>
        HttpResponse.json({
          self_delivery_enabled: true,
          platform_fleet_enabled: true,
          signups_open: false,
          subscription_plans: [],
        }),
      ),
    );
    renderWithProviders(<SellerSignupScreen />);
    expect(await screen.findByTestId('seller-signup-paused')).toBeOnTheScreen();
  });

  it('asks again for the plans when the chosen one was withdrawn meanwhile', async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl(SELLER_SIGNUP_OPTIONS_PATH), () => {
        calls += 1;
        return HttpResponse.json({
          self_delivery_enabled: true,
          platform_fleet_enabled: true,
          signups_open: true,
          subscription_plans: SIGNUP_SUBSCRIPTION_PLANS,
        });
      }),
      http.post(apiUrl(SELLER_SIGNUP_PATH), () =>
        HttpResponse.json(
          { error: { code: 'PRICING_PLAN_NOT_SELF_SELECTABLE', message: 'x' } },
          { status: 422 },
        ),
      ),
    );
    renderWithProviders(<SellerSignupScreen />);
    await screen.findByTestId('seller-signup-business-name');
    fireEvent.changeText(screen.getByTestId('seller-signup-business-name'), 'Thamel Kirana Pasal');
    fireEvent.changeText(screen.getByTestId('seller-signup-palika'), 'Kathmandu Metropolitan City');
    pinThamel();
    const before = calls;
    fireEvent.press(screen.getByRole('button', { name: 'Create my shop' }));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        'That plan is no longer on offer. Choose another and try again.',
      );
    });
    expect(calls).toBeGreaterThan(before);
  });
});

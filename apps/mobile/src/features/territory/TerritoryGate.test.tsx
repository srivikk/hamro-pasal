import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { AppState, Modal, Text, type AppStateStatus, type ModalProps } from 'react-native';
import { I18nextProvider } from 'react-i18next';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createI18n } from '../../i18n/i18n';
import { getAppStorage } from '../../storage/app-mmkv';
import { ENCRYPTION_KEY_VAULT_ENTRY, getSecureStorage } from '../../storage/secure-mmkv';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useDeliveryOtpStore } from '../../store/useDeliveryOtpStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { useOrderStore } from '../../store/useOrderStore';
import {
  checkoutResponse,
  NOODLES,
  ORDER_ID,
  THAMEL_ADDRESS,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import type { Coordinates, TerritoryDeps } from './territory';
import { TerritoryGate } from './TerritoryGate';
import { useTerritorySimulator } from './territory-simulator';

const KATHMANDU: Coordinates = { latitude: 27.7045, longitude: 85.3077 };
const NEW_DELHI: Coordinates = { latitude: 28.6139, longitude: 77.209 };
const GORAKHPUR: Coordinates = { latitude: 26.7606, longitude: 83.3732 };
const BLOCKED_TEXT = 'Service Unvailable in your territory';

function device(position: Coordinates | null, country: string | null = 'NP'): TerritoryDeps {
  return {
    requestPermission: jest.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
    getPosition: jest.fn(() => Promise.resolve(position)),
    reverseGeocodeCountry: jest.fn(() => Promise.resolve(country)),
  };
}

let queryClient: QueryClient;

/** Lets the chain of permission, position and geocoding promises settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderApp(deps?: TerritoryDeps) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(['feed'], { cached: true });
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={createI18n('en')}>
          <Text>App content</Text>
          <TerritoryGate splashMinMs={0} {...(deps === undefined ? {} : { deps })} />
        </I18nextProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await flush();
}

function seedLocalData(): void {
  useAuthStore.getState().setSession({ accessToken: 'access', refreshToken: 'refresh' });
  useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 2);
  useCheckoutStore.getState().startSession(checkoutResponse());
  useOrderStore
    .getState()
    .trackPlaced({ orderId: ORDER_ID, paymentMethod: 'COD', totalNpr: 1250 }, 1);
  useDeliveryOtpStore.getState().setOtp(ORDER_ID, '4821');
  useAddressStore.getState().setAddress(THAMEL_ADDRESS);
}

beforeEach(() => {
  useTerritorySimulator.setState({ simulation: 'off' });
  useBrowseLocationStore.setState({ device: null, deviceChecked: false, locationPrompt: 'idle' });
  // Past the welcome screen (a guest who skipped the login): the permission is asked at boot.
  useAuthStore.getState().clearSession();
  useOnboardingStore.getState().skipAuthWall();
});

afterAll(() => {
  useOnboardingStore.getState().resetOnboarding();
  useBrowseLocationStore.setState({ device: null, deviceChecked: false, locationPrompt: 'idle' });
});

describe('TerritoryGate (SPEC §1 tenant isolation)', () => {
  it('blocks immediately with the SPEC message when the device is outside Nepal', async () => {
    await renderApp(device(NEW_DELHI, 'IN'));

    expect(screen.getByTestId('territory-blocked')).toBeOnTheScreen();
    expect(screen.getByText(BLOCKED_TEXT)).toBeOnTheScreen();
    expect(
      screen.getByText('Hamro Pasal currently serves customers in Nepal only.'),
    ).toBeOnTheScreen();
  });

  it('clears the local cache on block, keeping only the keychain encryption key', async () => {
    seedLocalData();
    const encryptionKey = SecureStore.getItem(ENCRYPTION_KEY_VAULT_ENTRY);
    expect(encryptionKey).not.toBeNull();

    await renderApp(device(NEW_DELHI, 'IN'));

    expect(useCartStore.getState()).toMatchObject({ vendor: null, lines: [] });
    expect(useCheckoutStore.getState().session).toBeNull();
    expect(useOrderStore.getState().orders).toEqual({});
    expect(useDeliveryOtpStore.getState().otps).toEqual({});
    expect(useAddressStore.getState().address).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(queryClient.getQueryData(['feed'])).toBeUndefined();
    expect(getAppStorage().getAllKeys()).toEqual([]);
    expect(getSecureStorage().getAllKeys()).toEqual([]);
    expect(SecureStore.getItem(ENCRYPTION_KEY_VAULT_ENTRY)).toBe(encryptionKey);
  });

  it('blocks a foreign position inside the box once the geocoder names the country', async () => {
    await renderApp(device(GORAKHPUR, 'IN'));

    expect(screen.getByText(BLOCKED_TEXT)).toBeOnTheScreen();
  });

  it('lets the app through inside Nepal, without clearing anything', async () => {
    seedLocalData();
    await renderApp(device(KATHMANDU, 'NP'));

    expect(screen.queryByText(BLOCKED_TEXT)).toBeNull();
    expect(screen.queryByTestId('boot-splash')).toBeNull();
    expect(screen.getByText('App content')).toBeOnTheScreen();
    expect(useCartStore.getState().lines).toHaveLength(1);
  });

  it('keeps the splash up until the position is known', async () => {
    let resolvePosition: (position: Coordinates) => void = () => undefined;
    const deps = device(null);
    deps.getPosition = () =>
      new Promise((resolve) => {
        resolvePosition = resolve;
      });

    await renderApp(deps);
    expect(screen.getByTestId('boot-splash')).toBeOnTheScreen();
    expect(screen.getByTestId('boot-tagline')).toHaveTextContent('Hamro pasal sajilo cha hai');

    act(() => {
      resolvePosition(NEW_DELHI);
    });
    await flush();
    expect(screen.getByText(BLOCKED_TEXT)).toBeOnTheScreen();
  });

  it('cannot be dismissed with the Android back button', async () => {
    await renderApp(device(NEW_DELHI, 'IN'));

    const modal = screen.UNSAFE_getByType(Modal).props as ModalProps;
    act(() => {
      modal.onRequestClose?.({} as Parameters<NonNullable<ModalProps['onRequestClose']>>[0]);
    });

    expect(screen.getByText(BLOCKED_TEXT)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).toBeNull();
  });

  it('re-checks when the app returns to the foreground', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
    const deps = device(NEW_DELHI, 'IN');
    await renderApp(deps);
    expect(screen.getByText(BLOCKED_TEXT)).toBeOnTheScreen();

    // The customer travels back into Nepal and reopens the app.
    deps.getPosition = () => Promise.resolve(KATHMANDU);
    deps.reverseGeocodeCountry = () => Promise.resolve('NP');
    act(() => {
      for (const listener of listeners) listener('active');
    });
    await flush();

    expect(screen.queryByText(BLOCKED_TEXT)).toBeNull();
    // jest-expo's AppState is itself a mock: mockRestore() would strip its implementation, so
    // put back one that returns a subscription.
    spy.mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('opens the app without a position when the permission is refused', async () => {
    const deps = device(KATHMANDU);
    deps.requestPermission = jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true }));
    await renderApp(deps);

    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
    expect(deps.getPosition).not.toHaveBeenCalled();
    expect(screen.queryByTestId('boot-splash')).toBeNull();
    expect(screen.queryByTestId('territory-blocked')).toBeNull();
    expect(screen.getByText('App content')).toBeOnTheScreen();
    expect(useBrowseLocationStore.getState().device).toBeNull();
  });

  it('opens the app without a position when no fix could be obtained', async () => {
    await renderApp(device(null));

    expect(screen.queryByTestId('boot-splash')).toBeNull();
    expect(screen.getByText('App content')).toBeOnTheScreen();
    expect(useBrowseLocationStore.getState().device).toBeNull();
  });

  it('keeps the allowed position, and then its name, for the Home screen', async () => {
    const deps = device(KATHMANDU, 'NP');
    deps.describePlace = jest.fn(() => Promise.resolve('Thamel, Kathmandu'));
    await renderApp(deps);
    await flush();

    expect(useBrowseLocationStore.getState().device).toEqual({
      lat: KATHMANDU.latitude,
      lng: KATHMANDU.longitude,
      label: 'Thamel, Kathmandu',
    });
  });

  it('keeps the position when the place cannot be named', async () => {
    const deps = device(KATHMANDU, 'NP');
    deps.describePlace = jest.fn(() => Promise.reject(new Error('offline')));
    await renderApp(deps);
    await flush();

    expect(useBrowseLocationStore.getState().device).toEqual({
      lat: KATHMANDU.latitude,
      lng: KATHMANDU.longitude,
      label: null,
    });
  });

  it('forgets the position when a later check blocks', async () => {
    useBrowseLocationStore.getState().setDevice({ lat: 27.7, lng: 85.3, label: 'Kathmandu' });

    await renderApp(device(NEW_DELHI, 'IN'));

    expect(useBrowseLocationStore.getState().device).toBeNull();
  });

  it('asks for the permission at boot only: the foreground re-check never prompts', async () => {
    const listeners: ((state: AppStateStatus) => void)[] = [];
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
    const deps = device(KATHMANDU);
    deps.requestPermission = jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true }));
    deps.currentPermission = jest.fn(() => Promise.resolve({ granted: false, canAskAgain: true }));
    await renderApp(deps);

    act(() => {
      for (const listener of listeners) listener('active');
    });
    await flush();

    expect(deps.requestPermission).toHaveBeenCalledTimes(1);
    expect(deps.currentPermission).toHaveBeenCalledTimes(1);
    spy.mockImplementation(() => ({ remove: jest.fn() }));
  });

  it('shows the splash for its minimum time before asking for the location', async () => {
    jest.useFakeTimers();
    try {
      const deps = device(KATHMANDU);
      render(
        <QueryClientProvider client={new QueryClient()}>
          <I18nextProvider i18n={createI18n('en')}>
            <TerritoryGate deps={deps} splashMinMs={1500} />
          </I18nextProvider>
        </QueryClientProvider>,
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1499);
      });
      expect(screen.getByTestId('boot-splash')).toBeOnTheScreen();
      expect(screen.getByTestId('logo-placeholder')).toBeOnTheScreen();
      expect(deps.requestPermission).not.toHaveBeenCalled();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });

      expect(deps.requestPermission).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('boot-splash')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('permission sequence for a first-time visitor (welcome screen)', () => {
    beforeEach(() => {
      useOnboardingStore.getState().resetOnboarding();
    });

    it('does not show the OS prompt at boot; the splash still ends', async () => {
      const deps = device(KATHMANDU);
      deps.requestPermission = jest.fn(() => Promise.resolve({ granted: true, canAskAgain: true }));
      deps.currentPermission = jest.fn(() =>
        Promise.resolve({ granted: false, canAskAgain: true }),
      );
      await renderApp(deps);

      expect(deps.requestPermission).not.toHaveBeenCalled();
      expect(deps.currentPermission).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('boot-splash')).toBeNull();
      expect(useBrowseLocationStore.getState()).toMatchObject({
        device: null,
        deviceChecked: true,
        locationPrompt: 'idle',
      });
    });

    it('shows it when the welcome screen asks, and keeps the allowed position', async () => {
      const deps = device(KATHMANDU);
      deps.currentPermission = jest.fn(() =>
        Promise.resolve({ granted: false, canAskAgain: true }),
      );
      await renderApp(deps);

      act(() => {
        useBrowseLocationStore.getState().requestLocationPrompt();
      });
      await flush();

      expect(deps.requestPermission).toHaveBeenCalledTimes(1);
      expect(useBrowseLocationStore.getState()).toMatchObject({
        device: { lat: KATHMANDU.latitude, lng: KATHMANDU.longitude },
        locationPrompt: 'answered',
      });
    });

    it('reports "Don\'t allow" as answered with no position', async () => {
      const deps = device(KATHMANDU);
      deps.requestPermission = jest.fn(() =>
        Promise.resolve({ granted: false, canAskAgain: false }),
      );
      deps.currentPermission = jest.fn(() =>
        Promise.resolve({ granted: false, canAskAgain: true }),
      );
      await renderApp(deps);

      act(() => {
        useBrowseLocationStore.getState().requestLocationPrompt();
      });
      await flush();

      expect(useBrowseLocationStore.getState()).toMatchObject({
        device: null,
        locationPrompt: 'answered',
      });
    });

    it('needs no prompt when the permission was already granted', async () => {
      const deps = device(KATHMANDU);
      deps.currentPermission = jest.fn(() => Promise.resolve({ granted: true, canAskAgain: true }));
      await renderApp(deps);

      expect(deps.requestPermission).not.toHaveBeenCalled();
      expect(useBrowseLocationStore.getState().device).not.toBeNull();
    });
  });

  describe('__DEV__ simulator', () => {
    it('simulates a position outside Nepal, and back inside', async () => {
      useTerritorySimulator.setState({ simulation: 'outside' });
      await renderApp();
      expect(screen.getByText(BLOCKED_TEXT)).toBeOnTheScreen();

      // The toggle is reachable on the blocking screen itself, in development only.
      act(() => {
        fireEvent.press(screen.getByTestId('territory-simulate-inside'));
      });
      await flush();

      expect(screen.queryByText(BLOCKED_TEXT)).toBeNull();
    });
  });
});

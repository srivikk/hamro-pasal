import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import type * as ReactNativeModule from 'react-native';
import { Alert, Keyboard, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

import TrackOrderScreen, { orderToTrack } from '../../../app/track-order';
import { AddressFormModal } from '../../components/AddressFormModal';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useOrderStore } from '../../store/useOrderStore';
import { checkoutResponse, THAMEL_ADDRESS } from '../../test/api-fixtures';
import { mockNotifications, resetMockNotifications } from '../../test/fake-notifications';
import { mockWebView } from '../../test/mock-webview';
import { server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { AddressBookModal, tagHolder } from '../address/AddressBookModal';
import { CheckoutOutcome } from '../checkout/CheckoutStatus';
import { geocodeArea, PLACE_SEARCH_DEBOUNCE_MS, PLACE_SEARCH_URL } from '../location/place-search';
import { trackedOrderOfTap, useOrderNotificationTaps } from '../notifications/notification-taps';

jest.mock('expo-router', () => {
  const { Text } = jest.requireActual<typeof ReactNativeModule>('react-native');
  return {
    router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
    Stack: { Screen: () => null },
    Redirect: ({ href }: { href: unknown }) => (
      <Text testID="redirect">{JSON.stringify(href)}</Text>
    ),
    useLocalSearchParams: () => mockParams,
  };
});
let mockParams: Record<string, string> = {};
const mockRouter = jest.mocked(router);

setupApiTestEnvironment();

const ORDER_A = '4a1c0000-0000-4000-8000-0000004fa5b6';
const ORDER_B = '4a1c0000-0000-4000-8000-0000001f8a11';
const POKHARA = { latitude: 28.2096, longitude: 83.9856 };

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  useOrderStore.setState({ orders: {} });
  resetMockNotifications();
});

describe('Address form: the keyboard on Android', () => {
  it('pads the scroll content by the keyboard height while it shows, and not on iOS', () => {
    const listeners = new Map<string, (event: { endCoordinates: { height: number } }) => void>();
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
      listeners.set(name, listener as (event: { endCoordinates: { height: number } }) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof Keyboard.addListener>;
    });
    jest.replaceProperty(Platform, 'OS', 'android');
    renderWithProviders(
      <AddressFormModal visible initial={null} onSave={jest.fn()} onClose={jest.fn()} />,
    );
    const padding = () =>
      (
        screen.UNSAFE_getByType(ScrollView).props.contentContainerStyle as {
          paddingBottom: number;
        }
      ).paddingBottom;
    const resting = padding();

    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 300 } });
    });
    expect(padding()).toBe(resting + 300);
    // Android gets no KeyboardAvoidingView behaviour: the padding does the work.
    expect(screen.UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBeUndefined();
    expect(screen.UNSAFE_getByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled');

    act(() => {
      listeners.get('keyboardDidHide')?.({ endCoordinates: { height: 0 } });
    });
    expect(padding()).toBe(resting);

    jest.replaceProperty(Platform, 'OS', 'ios');
    act(() => {
      listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 300 } });
    });
    expect(padding()).toBe(resting);
    spy.mockRestore();
  });
});

describe('Address book: confirm before replacing a Home / Work address', () => {
  const FRIEND = {
    label: 'OTHER' as const,
    recipient: { name: 'Sita Gurung', phone: '+9779800000002' },
    address: { ...THAMEL_ADDRESS, tole_locality: 'Pulchowk' },
  };

  it('finds the entry a Home / Work draft would replace', () => {
    const { addresses } = useAddressStore.getState();
    const homeId = addresses[0]?.id;

    expect(tagHolder(addresses, 'HOME', undefined)?.id).toBe(homeId);
    // Editing the Home entry itself replaces nothing; Work is free; Other never conflicts.
    expect(tagHolder(addresses, 'HOME', homeId)).toBeNull();
    expect(tagHolder(addresses, 'WORK', undefined)).toBeNull();
    expect(tagHolder(addresses, 'OTHER', undefined)).toBeNull();
  });

  /** Opens the book, edits the friend's address and retags it as Home (a Home already exists). */
  function retagFriendAsHome() {
    const friendId = useAddressStore.getState().saveAddress(FRIEND) ?? '';
    const homeId = useAddressStore.getState().addresses[0]?.id ?? '';
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    renderWithProviders(<AddressBookModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByTestId(`address-edit-${friendId}`));
    fireEvent.press(screen.getByTestId('address-label-HOME'));
    fireEvent.press(screen.getByRole('button', { name: 'Save address' }));
    return { friendId, homeId, alert };
  }

  it('asks "A Home address already exists…" and saves nothing until answered', () => {
    const { friendId, homeId, alert } = retagFriendAsHome();

    expect(alert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alert.mock.calls[0] ?? [];
    expect(title).toBe('Replace Home address?');
    expect(message).toBe('A Home address already exists. Do you want to replace it?');
    expect(buttons?.map((button) => button.text)).toEqual(['Cancel', 'Replace']);
    expect(useAddressStore.getState().addresses.map((entry) => [entry.id, entry.label])).toEqual([
      [homeId, 'HOME'],
      [friendId, 'OTHER'],
    ]);
    // The form is still open, so "Cancel" leaves the customer where they were.
    expect(screen.getByRole('button', { name: 'Save address' })).toBeOnTheScreen();
    alert.mockRestore();
  });

  it('replaces the old Home on "Replace"', () => {
    const { friendId, alert } = retagFriendAsHome();
    const replace = alert.mock.calls[0]?.[2]?.find((button) => button.text === 'Replace');

    act(() => {
      replace?.onPress?.();
    });

    expect(useAddressStore.getState().addresses.map((entry) => [entry.id, entry.label])).toEqual([
      [friendId, 'HOME'],
    ]);
    alert.mockRestore();
  });

  it('does not ask when the tag is free', () => {
    const friendId = useAddressStore.getState().saveAddress(FRIEND) ?? '';
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    renderWithProviders(<AddressBookModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByTestId(`address-edit-${friendId}`));
    fireEvent.press(screen.getByTestId('address-label-WORK'));

    fireEvent.press(screen.getByRole('button', { name: 'Save address' }));

    expect(alert).not.toHaveBeenCalled();
    expect(useAddressStore.getState().addresses.map((entry) => entry.label)).toEqual([
      'HOME',
      'WORK',
    ]);
    alert.mockRestore();
  });
});

describe('Location search: rate-limit mitigation', () => {
  it('waits 1.2 s after the last keystroke', () => {
    expect(PLACE_SEARCH_DEBOUNCE_MS).toBe(1200);
  });
});

describe('Address form: the map opens on what was typed', () => {
  it('geocodes an area to its first match in Nepal, and to null when there is none', async () => {
    const asked: string[] = [];
    server.use(
      http.get(PLACE_SEARCH_URL, ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        asked.push(q);
        return HttpResponse.json(
          q.startsWith('Pokhara')
            ? [
                {
                  place_id: 1,
                  lat: '28.2096',
                  lon: '83.9856',
                  display_name: 'Pokhara, Kaski, Nepal',
                },
              ]
            : [],
        );
      }),
    );

    expect(await geocodeArea('Pokhara Metropolitan City, Kaski')).toEqual(POKHARA);
    expect(await geocodeArea('Nowhere')).toBeNull();
    expect(await geocodeArea('   ')).toBeNull();
    expect(asked).toEqual(['Pokhara Metropolitan City, Kaski', 'Nowhere']);
  });

  it('centres the map on the Palika and district already entered', async () => {
    const locateArea = jest.fn().mockResolvedValue(POKHARA);
    renderWithProviders(
      <AddressFormModal
        visible
        initial={null}
        onSave={jest.fn()}
        onClose={jest.fn()}
        locateArea={locateArea}
      />,
    );
    fireEvent.press(screen.getByTestId('address-province'));
    fireEvent.press(screen.getByText('4. Gandaki'));
    fireEvent.press(screen.getByTestId('address-district'));
    fireEvent.press(screen.getByText('Kaski'));
    fireEvent.changeText(screen.getByTestId('address-palika'), ' Pokhara Metropolitan City ');

    fireEvent.press(screen.getByTestId('address-pin-map'));

    await waitFor(() => {
      expect(mockWebView.props).not.toBeNull();
    });
    expect(locateArea).toHaveBeenCalledWith('Pokhara Metropolitan City, Kaski');
    const source = mockWebView.props?.source as { html: string };
    expect(source.html).toContain('setView([28.209600, 83.985600]');
  });

  it('opens on the default when the area cannot be found', async () => {
    const locateArea = jest.fn().mockResolvedValue(null);
    renderWithProviders(
      <AddressFormModal
        visible
        initial={null}
        onSave={jest.fn()}
        onClose={jest.fn()}
        locateArea={locateArea}
      />,
    );
    fireEvent.changeText(screen.getByTestId('address-palika'), 'Somewhere');

    fireEvent.press(screen.getByTestId('address-pin-map'));

    await waitFor(() => {
      expect(mockWebView.props).not.toBeNull();
    });
    expect((mockWebView.props?.source as { html: string }).html).toContain(
      'setView([27.715400, 85.312300]',
    );
  });

  it('opens on the existing pin without geocoding, and at once with nothing typed', async () => {
    const locateArea = jest.fn();
    const view = renderWithProviders(
      <AddressFormModal
        visible
        initial={{
          label: 'HOME',
          recipient: null,
          address: { ...THAMEL_ADDRESS, exact_lat: 27.6727, exact_lng: 85.3249 },
        }}
        onSave={jest.fn()}
        onClose={jest.fn()}
        locateArea={locateArea}
      />,
    );
    fireEvent.press(screen.getByTestId('address-pin-map'));
    await waitFor(() => {
      expect((mockWebView.props?.source as { html: string } | undefined)?.html).toContain(
        'setView([27.672700, 85.324900]',
      );
    });
    view.unmount();

    renderWithProviders(
      <AddressFormModal
        visible
        initial={null}
        onSave={jest.fn()}
        onClose={jest.fn()}
        locateArea={locateArea}
      />,
    );
    fireEvent.press(screen.getByTestId('address-pin-map'));
    await screen.findByText('Drop a pin');

    expect(locateArea).not.toHaveBeenCalled();
  });
});

describe('Track order', () => {
  function track(orderId: string, placedAt: number) {
    useOrderStore
      .getState()
      .trackPlaced({ orderId, paymentMethod: 'COD', totalNpr: 500 }, placedAt);
  }

  it('picks the newest order still on its way, else the newest, else none', () => {
    expect(orderToTrack({})).toBeNull();
    track(ORDER_A, 1_000);
    track(ORDER_B, 2_000);
    expect(orderToTrack(useOrderStore.getState().orders)).toBe(ORDER_B);

    useOrderStore.getState().setState(ORDER_B, 'DELIVERED');
    expect(orderToTrack(useOrderStore.getState().orders)).toBe(ORDER_A);

    useOrderStore.getState().setState(ORDER_A, 'CANCELED');
    expect(orderToTrack(useOrderStore.getState().orders)).toBe(ORDER_B);
  });

  it('hands the named order to the live tracking screen', () => {
    mockParams = { id: ORDER_A };
    renderWithProviders(<TrackOrderScreen />);

    expect(screen.getByTestId('redirect')).toHaveTextContent(
      JSON.stringify({ pathname: '/order/[id]', params: { id: ORDER_A } }),
    );
  });

  it('opens the latest order when none is named', () => {
    track(ORDER_A, 1_000);
    renderWithProviders(<TrackOrderScreen />);

    expect(screen.getByTestId('redirect')).toHaveTextContent(
      JSON.stringify({ pathname: '/order/[id]', params: { id: ORDER_A } }),
    );
  });

  it('says there is nothing to track, and sends a signed-out visitor to sign in', () => {
    const view = renderWithProviders(<TrackOrderScreen />);
    expect(screen.getByTestId('track-empty')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Browse shops' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    view.unmount();

    useAuthStore.getState().clearSession();
    renderWithProviders(<TrackOrderScreen />);

    expect(screen.getByTestId('redirect')).toHaveTextContent(JSON.stringify('/login'));
  });

  it('is where the cart’s "Track order" button goes', () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    const orderId = useCheckoutStore.getState().session?.orderId ?? '';
    useCheckoutStore.getState().setOrderState(orderId, 'PLACED');
    renderWithProviders(<CheckoutOutcome />);

    fireEvent.press(screen.getByRole('button', { name: 'Track order' }));

    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/track-order',
      params: { id: orderId },
    });
  });
});

describe('Tapping an order notification', () => {
  const tap = (data: unknown) => ({ notification: { request: { content: { data } } } });
  const customerPush = {
    type: 'order.state_changed',
    notification_id: 'e1f0c000-0000-4000-8000-000000000001',
    order_id: ORDER_A,
    state: 'OUT_FOR_DELIVERY',
    audience: 'CUSTOMER',
    data_only: false,
    title: 'Your order is on its way',
    body: 'Order #4FA5B6 has left the shop.',
  };

  it('names the order of a customer push only', () => {
    expect(trackedOrderOfTap(tap(customerPush))).toBe(ORDER_A);
    expect(trackedOrderOfTap(tap({ ...customerPush, audience: 'VENDOR' }))).toBeNull();
    expect(trackedOrderOfTap(tap({ type: 'something.else' }))).toBeNull();
    expect(trackedOrderOfTap(tap(undefined))).toBeNull();
  });

  it('opens that order’s tracking while the app is running', () => {
    renderHook(() => {
      useOrderNotificationTaps();
    });

    act(() => {
      for (const listener of mockNotifications.responseListeners) listener(tap(customerPush));
    });

    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/track-order',
      params: { id: ORDER_A },
    });
  });

  it('opens it when the tap is what started the app, and stops listening on unmount', () => {
    mockNotifications.lastResponse = tap(customerPush);
    const { unmount } = renderHook(() => {
      useOrderNotificationTaps();
    });

    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockNotifications.responseListeners).toEqual([]);
  });
});

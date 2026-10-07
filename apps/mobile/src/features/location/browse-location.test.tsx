import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import { VENDORS_PATH } from '../../api/catalog';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { feedResponse, THAMEL_ADDRESS } from '../../test/api-fixtures';
import { mockWebView } from '../../test/mock-webview';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { useCustomerLocation } from './customer-location';
import { describePlace } from './describe-place';
import { LocationHeader } from './LocationHeader';
import { mapPinHtml, parseMapPinMessage } from './map-pin';
import { PLACE_SEARCH_URL } from './place-search';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

setupApiTestEnvironment();

const PATAN = { latitude: 27.6727, longitude: 85.3249 };
const DELHI = { latitude: 28.6139, longitude: 77.209 };

describe('map pin page', () => {
  it('opens on the given position, limited to Nepal, and interpolates numbers only', () => {
    const html = mapPinHtml(PATAN);

    expect(html).toContain('setView([27.672700, 85.324900], 16)');
    expect(html).toContain('maxBounds: [[26.347, 80.058], [30.447, 88.201]]');
    expect(html).toContain('window.ReactNativeWebView.postMessage');
  });

  it('reads the centre the page posts and says whether it is inside Nepal', () => {
    expect(
      parseMapPinMessage(JSON.stringify({ type: 'center', lat: 27.6727, lng: 85.3249 })),
    ).toEqual({ kind: 'center', position: PATAN, insideNepal: true });
    expect(
      parseMapPinMessage(JSON.stringify({ type: 'center', lat: 28.6139, lng: 77.209 })),
    ).toMatchObject({ insideNepal: false });
    expect(parseMapPinMessage(JSON.stringify({ type: 'error' }))).toEqual({ kind: 'error' });
  });

  it.each(['not json', '{}', '{"type":"center","lat":"27","lng":85}', '{"type":"other"}'])(
    'ignores %p',
    (data) => {
      expect(parseMapPinMessage(data)).toBeNull();
    },
  );
});

describe('browse location store and useCustomerLocation', () => {
  it('follows the delivery address until a place is chosen, and again once it is cleared', () => {
    const { result } = renderHook(() => useCustomerLocation());
    expect(result.current).toEqual({
      lat: THAMEL_ADDRESS.exact_lat,
      lng: THAMEL_ADDRESS.exact_lng,
      municipalityPalika: THAMEL_ADDRESS.municipality_palika_string,
    });

    act(() => {
      useBrowseLocationStore.getState().setOverride({
        lat: PATAN.latitude,
        lng: PATAN.longitude,
        label: 'Patan',
        municipalityPalika: null,
      });
    });
    expect(result.current).toEqual({ lat: 27.6727, lng: 85.3249, municipalityPalika: null });
    // Browsing elsewhere never changes where the order is delivered.
    expect(useAddressStore.getState().address).toEqual(THAMEL_ADDRESS);

    act(() => {
      useBrowseLocationStore.getState().clearOverride();
    });
    expect(result.current.lat).toBe(THAMEL_ADDRESS.exact_lat);
  });

  it('refuses a place outside Nepal', () => {
    const accepted = useBrowseLocationStore.getState().setOverride({
      lat: DELHI.latitude,
      lng: DELHI.longitude,
      label: 'Delhi',
      municipalityPalika: null,
    });

    expect(accepted).toBe(false);
    expect(useBrowseLocationStore.getState().override).toBeNull();
  });
});

describe('Home location header', () => {
  /** Serves the feed and records the location each request asked for. */
  function serveFeed() {
    const queries: Record<string, string>[] = [];
    server.use(
      http.get(apiUrl(VENDORS_PATH), ({ request }) => {
        queries.push(Object.fromEntries(new URL(request.url).searchParams));
        return HttpResponse.json(feedResponse());
      }),
    );
    return queries;
  }

  it('shows the delivery address, and asks the feed around a selected suggestion instead', async () => {
    const queries = serveFeed();
    server.use(
      http.get(PLACE_SEARCH_URL, () =>
        HttpResponse.json([
          {
            place_id: 101,
            lat: '27.6727',
            lon: '85.3249',
            name: 'Patan Durbar Square',
            display_name: 'Patan Durbar Square, Lalitpur, Bagmati Province, 44700, Nepal',
            address: { city: 'Lalitpur', state: 'Bagmati Province' },
          },
        ]),
      ),
    );
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    expect(screen.getByTestId('location-header-label')).toHaveTextContent(
      'Thamel, Kathmandu Metropolitan City-26, Kathmandu',
    );

    fireEvent.press(screen.getByTestId('location-header'));
    fireEvent.changeText(screen.getByTestId('place-search'), 'Patan Durbar');
    fireEvent.press(await screen.findByTestId('place-suggestion-101', {}, { timeout: 3000 }));

    await waitFor(() => {
      expect(queries).toHaveLength(2);
    });
    expect(queries[0]).toEqual({
      lat: '27.7154',
      lng: '85.3123',
      municipality_palika_string: 'Kathmandu Metropolitan City',
    });
    // The new coordinates, and no Palika: a searched point does not name one.
    expect(queries[1]).toEqual({ lat: '27.6727', lng: '85.3249' });
    // The modal is closed and the header already shows the readable name.
    expect(screen.queryByTestId('place-search')).toBeNull();
    expect(screen.getByTestId('location-header-label')).toHaveTextContent(
      'Patan Durbar Square, Lalitpur',
    );
  });

  it('browses around a saved address with its Palika, and returns to the delivery address', () => {
    const workId = useAddressStore.getState().saveAddress({
      label: 'WORK',
      recipient: null,
      address: {
        ...THAMEL_ADDRESS,
        district_string: 'Lalitpur',
        municipality_palika_string: 'Lalitpur Metropolitan City',
        ward_number: 16,
        tole_locality: 'Pulchowk',
        exact_lat: 27.6781,
        exact_lng: 85.3167,
      },
    });
    const homeId = useAddressStore.getState().addresses[0]?.id ?? '';
    useAddressStore.getState().selectAddress(homeId);
    renderWithProviders(<LocationHeader />);

    fireEvent.press(screen.getByTestId('location-header'));
    fireEvent.press(screen.getByTestId(`browse-address-${workId ?? ''}`));

    expect(useBrowseLocationStore.getState().override).toEqual({
      lat: 27.6781,
      lng: 85.3167,
      label: 'Pulchowk, Lalitpur Metropolitan City-16, Lalitpur',
      municipalityPalika: 'Lalitpur Metropolitan City',
    });
    expect(useAddressStore.getState().selectedId).toBe(homeId);

    fireEvent.press(screen.getByTestId('location-header'));
    fireEvent.press(screen.getByTestId('browse-reset'));

    expect(useBrowseLocationStore.getState().override).toBeNull();
    expect(screen.getByTestId('location-header-label')).toHaveTextContent(/^Thamel, /);
  });

  it('browses around the device position, and explains when it cannot be read', async () => {
    renderWithProviders(
      <LocationHeader
        deps={{ locate: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(PATAN) }}
      />,
    );
    fireEvent.press(screen.getByTestId('location-header'));

    fireEvent.press(screen.getByTestId('browse-current-location'));
    expect(await screen.findByTestId('place-search-problem')).toHaveTextContent(
      "Couldn't get your location. Check that GPS is on and try again.",
    );

    fireEvent.press(screen.getByTestId('browse-current-location'));
    await waitFor(() => {
      expect(useBrowseLocationStore.getState().override).toMatchObject({
        lat: 27.6727,
        label: 'Current location',
      });
    });
  });

  it('browses around a pin dropped on the map (unnamed: a neutral label, no coordinates)', async () => {
    renderWithProviders(<LocationHeader />);
    fireEvent.press(screen.getByTestId('location-header'));
    fireEvent.press(screen.getByTestId('browse-pick-on-map'));

    const onMessage = mockWebView.props?.onMessage;
    act(() => {
      onMessage?.({
        nativeEvent: { data: JSON.stringify({ type: 'center', lat: 28.2096, lng: 83.9856 }) },
      } as Parameters<NonNullable<typeof onMessage>>[0]);
    });
    fireEvent.press(screen.getByRole('button', { name: 'Use this location' }));

    await waitFor(() => {
      expect(useBrowseLocationStore.getState().override).toEqual({
        lat: 28.2096,
        lng: 83.9856,
        label: 'Pinned location',
        municipalityPalika: null,
      });
    });
  });

  it('does not show a guest the saved addresses or the full address line', () => {
    useAuthStore.getState().clearSession();
    renderWithProviders(<LocationHeader />);

    expect(screen.getByTestId('location-header-label')).toHaveTextContent(
      'Kathmandu Metropolitan City',
    );
    expect(screen.getByTestId('location-header-label')).not.toHaveTextContent('Thamel');
    fireEvent.press(screen.getByTestId('location-header'));

    expect(screen.queryByText('Saved addresses')).toBeNull();
  });
});

describe('Select delivery location: names and the device-location banner', () => {
  afterEach(() => {
    jest.mocked(describePlace).mockResolvedValue(null);
  });

  it('names a pin dropped on the map instead of showing coordinates', async () => {
    jest.mocked(describePlace).mockResolvedValue('Lakeside Road, Pokhara');
    renderWithProviders(<LocationHeader />);
    fireEvent.press(screen.getByTestId('location-header'));
    fireEvent.press(screen.getByTestId('browse-pick-on-map'));

    const onMessage = mockWebView.props?.onMessage;
    act(() => {
      onMessage?.({
        nativeEvent: { data: JSON.stringify({ type: 'center', lat: 28.2096, lng: 83.9856 }) },
      } as Parameters<NonNullable<typeof onMessage>>[0]);
    });
    fireEvent.press(screen.getByRole('button', { name: 'Use this location' }));

    await waitFor(() => {
      expect(useBrowseLocationStore.getState().override?.label).toBe('Lakeside Road, Pokhara');
    });
    expect(describePlace).toHaveBeenCalledWith({ latitude: 28.2096, longitude: 83.9856 });
    expect(screen.getByTestId('location-header-label')).toHaveTextContent('Lakeside Road, Pokhara');
    expect(screen.queryByText(/28.2096/)).toBeNull();
  });

  it('names the device position chosen with "Use current location"', async () => {
    jest.mocked(describePlace).mockResolvedValue('Patan Dhoka, Lalitpur');
    renderWithProviders(<LocationHeader deps={{ locate: () => Promise.resolve(PATAN) }} />);
    fireEvent.press(screen.getByTestId('location-header'));

    fireEvent.press(screen.getByTestId('browse-current-location'));

    await waitFor(() => {
      expect(useBrowseLocationStore.getState().override).toMatchObject({
        lat: 27.6727,
        label: 'Patan Dhoka, Lalitpur',
      });
    });
  });

  it('warns that the device location is off, with Enable opening the OS settings', () => {
    const openSettings = jest.fn();
    renderWithProviders(<LocationHeader deps={{ openSettings }} />);
    fireEvent.press(screen.getByTestId('location-header'));

    expect(screen.getByText('Select delivery location')).toBeOnTheScreen();
    expect(screen.getByTestId('location-off-banner')).toBeOnTheScreen();
    expect(screen.getByText('Device location not enabled')).toBeOnTheScreen();
    expect(screen.getByPlaceholderText('Search for area, street name...')).toBeOnTheScreen();
    expect(screen.getByText('Use current location')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Enable' }));

    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('shows no warning once the device position is known', () => {
    useBrowseLocationStore.getState().setDevice({ lat: 27.7154, lng: 85.3123, label: 'Thamel' });
    renderWithProviders(<LocationHeader />);
    fireEvent.press(screen.getByTestId('location-header'));

    expect(screen.queryByTestId('location-off-banner')).toBeNull();
  });

  it('lists the saved addresses as tagged rows with the full address', () => {
    renderWithProviders(<LocationHeader />);
    fireEvent.press(screen.getByTestId('location-header'));

    expect(screen.getByText('Saved addresses')).toBeOnTheScreen();
    expect(screen.getByText('Home')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Near Kathmandu Guest House, Thamel, Kathmandu Metropolitan City-26, Kathmandu',
      ),
    ).toBeOnTheScreen();
  });
});

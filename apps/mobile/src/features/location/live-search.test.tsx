import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { delay, http, HttpResponse } from 'msw';

import WelcomeScreen from '../../../app/welcome';
import { useAuthStore } from '../../store/useAuthStore';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { LocationHeader } from './LocationHeader';
import {
  PLACE_SEARCH_DEBOUNCE_MS,
  PLACE_SEARCH_URL,
  searchPlaces,
  toPlaceQuery,
  toPlaceSuggestions,
} from './place-search';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: () => null,
  useLocalSearchParams: () => ({}),
}));
const mockRouter = jest.mocked(router);

setupApiTestEnvironment();

const THAMEL = {
  place_id: 11,
  lat: '27.7154',
  lon: '85.3123',
  name: 'Thamel',
  display_name: 'Thamel, Kathmandu, Bagmati Province, 44600, Nepal',
  address: { suburb: 'Thamel', city: 'Kathmandu', state: 'Bagmati Province', country: 'Nepal' },
};
const THAMEL_MARG = {
  place_id: 12,
  lat: '27.7149',
  lon: '85.3101',
  display_name: 'Thamel Marg, Thamel, Kathmandu, Bagmati Province, Nepal',
  address: { road: 'Thamel Marg', city: 'Kathmandu' },
};
const DELHI = {
  place_id: 13,
  lat: '28.6139',
  lon: '77.2090',
  name: 'Thamel Restaurant',
  display_name: 'Thamel Restaurant, New Delhi, India',
};

/** Serves the search endpoint and records each request's query string parameters. */
function serveSearch(respond: (q: string) => Response | Promise<Response>) {
  const asked: Record<string, string>[] = [];
  server.use(
    http.get(PLACE_SEARCH_URL, ({ request }) => {
      const params = Object.fromEntries(new URL(request.url).searchParams);
      asked.push(params);
      return respond(params.q ?? '');
    }),
  );
  return asked;
}

const type = (text: string) => {
  fireEvent.changeText(screen.getByTestId('place-search'), text);
};
const waitOutDebounce = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, PLACE_SEARCH_DEBOUNCE_MS + 100));
  });

function openSelector() {
  renderWithProviders(<LocationHeader />);
  fireEvent.press(screen.getByTestId('location-header'));
}

beforeEach(() => {
  jest.clearAllMocks();
  useOnboardingStore.getState().resetOnboarding();
});

describe('toPlaceSuggestions / toPlaceQuery', () => {
  it('splits a result into the area and the city line, and builds the header label', () => {
    expect(toPlaceSuggestions([THAMEL, THAMEL_MARG])).toEqual([
      {
        id: '11',
        lat: 27.7154,
        lng: 85.3123,
        title: 'Thamel',
        subtitle: 'Kathmandu, Bagmati Province',
        label: 'Thamel, Kathmandu',
      },
      {
        id: '12',
        lat: 27.7149,
        lng: 85.3101,
        title: 'Thamel Marg',
        subtitle: 'Thamel, Kathmandu, Bagmati Province',
        label: 'Thamel Marg, Kathmandu',
      },
    ]);
  });

  it('drops results outside Nepal and anything malformed', () => {
    expect(toPlaceSuggestions([DELHI, { lat: 'x' }, null, THAMEL]).map((s) => s.id)).toEqual([
      '11',
    ]);
    expect(toPlaceSuggestions({ error: 'nope' })).toEqual([]);
  });

  it('normalises what was typed', () => {
    expect(toPlaceQuery('  Patan   Durbar ')).toBe('Patan Durbar');
  });
});

describe('searchPlaces', () => {
  it('asks the search URL with the documented parameters, limited to Nepal', async () => {
    const asked = serveSearch(() => HttpResponse.json([THAMEL]));

    const suggestions = await searchPlaces('Thamel Marg');

    expect(asked).toEqual([
      { q: 'Thamel Marg', format: 'json', addressdetails: '1', limit: '5', countrycodes: 'np' },
    ]);
    expect(suggestions).toHaveLength(1);
  });

  it('throws when the service refuses', async () => {
    serveSearch(() => HttpResponse.json({}, { status: 429 }));

    await expect(searchPlaces('Thamel')).rejects.toThrow();
  });
});

describe('Select delivery location: live search', () => {
  it('shows the default view until two characters are typed, and asks nothing before that', async () => {
    const asked = serveSearch(() => HttpResponse.json([THAMEL]));
    openSelector();

    expect(screen.getByTestId('browse-current-location')).toBeOnTheScreen();
    expect(screen.getByText('Saved addresses')).toBeOnTheScreen();

    type('T');
    await waitOutDebounce();

    expect(screen.getByTestId('browse-current-location')).toBeOnTheScreen();
    expect(asked).toEqual([]);
  });

  it('hides the default view at two characters and lists the suggestions', async () => {
    serveSearch(() => HttpResponse.json([THAMEL, THAMEL_MARG]));
    openSelector();

    type('Th');

    // At once: the default view gives way, with a loading indicator in the search bar.
    expect(screen.queryByTestId('browse-current-location')).toBeNull();
    expect(screen.queryByText('Saved addresses')).toBeNull();
    expect(screen.getByTestId('place-search-loading')).toBeOnTheScreen();

    const first = await screen.findByTestId('place-suggestion-11', {}, { timeout: 3000 });
    expect(first).toHaveTextContent(/Thamel/);
    expect(screen.getByText('Kathmandu, Bagmati Province')).toBeOnTheScreen();
    expect(screen.getByText('Thamel Marg')).toBeOnTheScreen();
    expect(screen.queryByTestId('place-search-loading')).toBeNull();
  });

  it('debounces: a burst of typing makes one request, with the last text', async () => {
    const asked = serveSearch(() => HttpResponse.json([THAMEL]));
    openSelector();

    for (const text of ['Th', 'Tha', 'Tham', 'Thame', 'Thamel']) type(text);
    await screen.findByTestId('place-suggestion-11', {}, { timeout: 3000 });

    expect(asked.map((params) => params.q)).toEqual(['Thamel']);
  });

  it('brings the default view back when the field is cleared', async () => {
    serveSearch(() => HttpResponse.json([THAMEL]));
    openSelector();
    type('Thamel');
    await screen.findByTestId('place-suggestion-11', {}, { timeout: 3000 });

    fireEvent.press(screen.getByTestId('place-search-clear'));

    expect(screen.getByTestId('browse-current-location')).toBeOnTheScreen();
    expect(screen.queryByTestId('place-suggestion-11')).toBeNull();
  });

  it('writes the tapped suggestion to the browse-location store and closes', async () => {
    serveSearch(() => HttpResponse.json([THAMEL_MARG]));
    openSelector();
    type('Thamel Marg');

    fireEvent.press(await screen.findByTestId('place-suggestion-12', {}, { timeout: 3000 }));

    expect(useBrowseLocationStore.getState().override).toEqual({
      lat: 27.7149,
      lng: 85.3101,
      label: 'Thamel Marg, Kathmandu',
      municipalityPalika: null,
    });
    expect(screen.queryByTestId('place-search')).toBeNull();
    expect(screen.getByTestId('location-header-label')).toHaveTextContent('Thamel Marg, Kathmandu');
  });

  it('says so when nothing in Nepal matches', async () => {
    serveSearch(() => HttpResponse.json([DELHI]));
    openSelector();
    type('Delhi');

    expect(
      await screen.findByText(
        'No matching places in Nepal. Try another name.',
        {},
        { timeout: 3000 },
      ),
    ).toBeOnTheScreen();
  });

  it('explains a failed search and keeps the current location', async () => {
    serveSearch(() => HttpResponse.error());
    openSelector();
    type('Thamel');

    expect(
      await screen.findByTestId('place-search-problem', {}, { timeout: 3000 }),
    ).toHaveTextContent("Search isn't available right now. Pick the place on the map instead.");
    expect(useBrowseLocationStore.getState().override).toBeNull();
  });

  it('keeps the spinner while the answer is on its way', async () => {
    serveSearch(async () => {
      await delay(300);
      return HttpResponse.json([THAMEL]);
    });
    openSelector();
    type('Thamel');
    await waitOutDebounce();

    expect(screen.getByTestId('place-search-loading')).toBeOnTheScreen();
    await screen.findByTestId('place-suggestion-11', {}, { timeout: 3000 });
  });
});

describe('Welcome screen: the location permission sequence', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
  });

  it('asks for the OS prompt once the splash is gone and this screen is showing', () => {
    renderWithProviders(<WelcomeScreen />);
    expect(useBrowseLocationStore.getState().locationPrompt).toBe('idle');

    act(() => {
      useBrowseLocationStore.getState().markDeviceChecked();
    });

    expect(useBrowseLocationStore.getState().locationPrompt).toBe('requested');
    expect(screen.queryByText('Select delivery location')).toBeNull();
  });

  it('does not ask when the position is already known', () => {
    useBrowseLocationStore.getState().setDevice({ lat: 27.7154, lng: 85.3123, label: 'Thamel' });
    renderWithProviders(<WelcomeScreen />);

    act(() => {
      useBrowseLocationStore.getState().markDeviceChecked();
    });

    expect(useBrowseLocationStore.getState().locationPrompt).toBe('idle');
  });

  it('surfaces "Select delivery location" with the banner as soon as the prompt is refused', async () => {
    renderWithProviders(<WelcomeScreen />);
    act(() => {
      useBrowseLocationStore.getState().markDeviceChecked();
    });

    // "Don't allow": the location check answers without a position.
    act(() => {
      useBrowseLocationStore.getState().markLocationPromptAnswered();
    });

    expect(await screen.findByText('Select delivery location')).toBeOnTheScreen();
    expect(screen.getByTestId('location-off-banner')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Enable' })).toBeOnTheScreen();
  });

  it('stays on the welcome screen when the prompt is allowed', () => {
    renderWithProviders(<WelcomeScreen />);
    act(() => {
      useBrowseLocationStore.getState().markDeviceChecked();
    });

    act(() => {
      useBrowseLocationStore.getState().setDevice({ lat: 27.7154, lng: 85.3123, label: null });
      useBrowseLocationStore.getState().markLocationPromptAnswered();
    });

    expect(screen.queryByText('Select delivery location')).toBeNull();
    expect(screen.getByTestId('skip-login')).toBeOnTheScreen();
  });

  it('goes on to Home as a guest once a suggestion is chosen there', async () => {
    serveSearch(() => HttpResponse.json([THAMEL]));
    renderWithProviders(<WelcomeScreen />);
    act(() => {
      useBrowseLocationStore.getState().markDeviceChecked();
      useBrowseLocationStore.getState().markLocationPromptAnswered();
    });
    await screen.findByText('Select delivery location');

    type('Thamel');
    fireEvent.press(await screen.findByTestId('place-suggestion-11', {}, { timeout: 3000 }));

    expect(useBrowseLocationStore.getState().override?.label).toBe('Thamel, Kathmandu');
    expect(useOnboardingStore.getState().authWallSkipped).toBe(true);
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await waitFor(() => {
      expect(screen.queryByText('Select delivery location')).toBeNull();
    });
  });

  it('returns to the welcome screen when the selector is dismissed, and does not reopen it', async () => {
    renderWithProviders(<WelcomeScreen />);
    act(() => {
      useBrowseLocationStore.getState().markDeviceChecked();
      useBrowseLocationStore.getState().markLocationPromptAnswered();
    });
    await screen.findByText('Select delivery location');

    fireEvent.press(screen.getByTestId('location-picker-close'));

    await waitFor(() => {
      expect(screen.queryByText('Select delivery location')).toBeNull();
    });
    expect(screen.getByTestId('skip-login')).toBeOnTheScreen();
    expect(useOnboardingStore.getState().authWallSkipped).toBe(false);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

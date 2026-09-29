import { fireEvent, screen, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import FeedScreen from '../../../app/(tabs)/index';
import { VENDORS_PATH } from '../../api/catalog';
import {
  errorBody,
  feedResponse,
  NEW_ROAD_VENDOR,
  PATAN_VENDOR,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

setupApiTestEnvironment();

function serveFeed(respond: () => Response = () => HttpResponse.json(feedResponse())) {
  let calls = 0;
  server.use(
    http.get(apiUrl(VENDORS_PATH), () => {
      calls += 1;
      return respond();
    }),
  );
  return () => calls;
}

describe('Feed screen (GET /api/vendors)', () => {
  it('shows serviceable vendors first, then a disabled Explore Further section', async () => {
    serveFeed();
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('feed-loading')).toBeOnTheScreen();
    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();

    const exploreHeader = screen.getByTestId('explore-further-header');
    expect(within(exploreHeader).getByText('Explore Further')).toBeOnTheScreen();
    expect(
      screen.getAllByTestId(/^vendor-card-/).map((card) => card.props.testID as string),
    ).toEqual([
      `vendor-card-${THAMEL_VENDOR.id}`,
      `vendor-card-${NEW_ROAD_VENDOR.id}`,
      `vendor-card-${PATAN_VENDOR.id}`,
    ]);

    const patan = screen.getByTestId(`vendor-card-${PATAN_VENDOR.id}`);
    const thamel = screen.getByTestId(`vendor-card-${THAMEL_VENDOR.id}`);
    expect(patan).toBeDisabled();
    expect(within(patan).getByText("Doesn't deliver to you")).toBeOnTheScreen();
    expect(within(thamel).queryByText("Doesn't deliver to you")).toBeNull();
  });

  it('shows the empty state when no vendor delivers to the customer', async () => {
    serveFeed(() => HttpResponse.json(feedResponse({ serviceable: [] })));
    renderWithProviders(<FeedScreen />);

    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();
    expect(screen.getByTestId(`vendor-card-${PATAN_VENDOR.id}`)).toBeDisabled();
    expect(screen.queryByTestId(`vendor-card-${THAMEL_VENDOR.id}`)).toBeNull();
  });

  it('offers a retry when the feed cannot be loaded', async () => {
    let fail = true;
    const calls = serveFeed(() =>
      fail
        ? HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 })
        : HttpResponse.json(feedResponse()),
    );
    renderWithProviders(<FeedScreen />);

    expect(
      await screen.findByText("Couldn't load shops. Check your connection."),
    ).toBeOnTheScreen();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId(`vendor-card-${THAMEL_VENDOR.id}`)).toBeOnTheScreen();
    expect(calls()).toBe(2);
  });

  it('renders the feed in Nepali with Devanagari numerals', async () => {
    serveFeed();
    renderWithProviders(<FeedScreen />, { locale: 'ne' });

    expect(await screen.findByText('तपाईंकहाँ डेलिभरी गर्ने पसलहरू')).toBeOnTheScreen();
    expect(screen.getByText('थप पसलहरू हेर्नुहोस्')).toBeOnTheScreen();
    expect(screen.getAllByText('डेलिभरी शुल्क रु. ५०').length).toBeGreaterThan(0);
  });
});

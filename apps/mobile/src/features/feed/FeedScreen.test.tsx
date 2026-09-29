import { screen, within } from '@testing-library/react-native';

import FeedScreen from '../../../app/(tabs)/index';
import { renderWithProviders } from '../../test/render';
import type * as MockFeedApi from './mock-feed-api';
import { MOCK_VENDORS } from './mock-feed-api';

// Drop the simulated network latency so the screen settles well inside findBy's timeout.
jest.mock('./mock-feed-api', () => {
  const actual = jest.requireActual<typeof MockFeedApi>('./mock-feed-api');
  return {
    ...actual,
    fetchMockFeed: (customer: Parameters<typeof actual.fetchMockFeed>[0]) =>
      actual.fetchMockFeed(customer, { latencyMs: 0 }),
  };
});

describe('Feed screen', () => {
  it('shows serviceable vendors first, then a disabled Explore Further section', async () => {
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('feed-loading')).toBeOnTheScreen();
    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();

    const exploreHeader = screen.getByTestId('explore-further-header');
    expect(within(exploreHeader).getByText('Explore Further')).toBeOnTheScreen();

    const cardOrder = screen
      .getAllByTestId(/^vendor-card-/)
      .map(
        (card) =>
          MOCK_VENDORS.find((v) => `vendor-card-${v.id}` === card.props.testID)?.business_name,
      );
    expect(cardOrder).toEqual([
      'Thamel Kirana Pasal',
      'New Road Electronics',
      'Boudha Fresh Mart',
      'Pokhara Dhaka Topi Bhandar',
      'Patan Organic Store',
      'Kirtipur Tarkari Pasal',
    ]);

    const patan = screen.getByTestId('vendor-card-6f1c2a10-0000-4000-8000-000000000012');
    const thamel = screen.getByTestId('vendor-card-6f1c2a10-0000-4000-8000-000000000011');
    expect(patan).toBeDisabled();
    expect(within(patan).getByText("Doesn't deliver to you")).toBeOnTheScreen();
    expect(within(thamel).queryByText("Doesn't deliver to you")).toBeNull();
    expect(screen.queryByText('Bhaktapur Juju Dhau Bhandar')).toBeNull();
  });

  it('renders the feed in Nepali with Devanagari numerals', async () => {
    renderWithProviders(<FeedScreen />, { locale: 'ne' });

    expect(await screen.findByText('तपाईंकहाँ डेलिभरी गर्ने पसलहरू')).toBeOnTheScreen();
    expect(screen.getByText('थप पसलहरू हेर्नुहोस्')).toBeOnTheScreen();
    expect(screen.getAllByText('डेलिभरी शुल्क रु. ५०').length).toBeGreaterThan(0);
  });
});

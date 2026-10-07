import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import { ScrollView } from 'react-native';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import { VENDORS_PATH } from '../../api/catalog';
import { VendorCard } from '../../components/VendorCard';
import {
  feedResponse,
  NEW_ROAD_VENDOR,
  PATAN_VENDOR,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { sortFeed, type FeedSort } from '../feed/feed-sort';
import { SortFilterSheet } from '../feed/SortFilterSheet';
import { BANNER_INTERVAL_MS, BannerCarousel } from './BannerCarousel';
import { FeaturedOffers } from './FeaturedOffers';
import type * as MockPromotionsModule from './mock-promotions';
import { homePromotions, vendorExtras } from './mock-promotions';
import {
  deliveryWindow,
  estimatedDeliveryMinutes,
  NO_PROMOTIONS,
  NO_VENDOR_EXTRAS,
  type FeaturedOffer,
  type ExtrasSubject,
  type PromoBanner,
  type VendorExtras,
} from './promo-model';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
// The screens read promotions and shop extras from one module; the tests decide what it answers.
jest.mock('./mock-promotions', () => ({
  PROMO_MOCKS_ENABLED: true,
  homePromotions: jest.fn(),
  vendorExtras: jest.fn(),
}));

setupApiTestEnvironment();

const realMocks = jest.requireActual<typeof MockPromotionsModule>('./mock-promotions');

const BANNERS: PromoBanner[] = [
  {
    id: 'b1',
    placement: 'CAROUSEL',
    image_url: 'https://cdn.test/b1.jpg',
    title: 'Dashain offers',
    subtitle: 'Festive deals',
    target_type: 'SHOP',
    target_value: THAMEL_VENDOR.id,
  },
  {
    id: 'b2',
    placement: 'CAROUSEL',
    image_url: 'https://cdn.test/b2.jpg',
    title: null,
    subtitle: null,
    target_type: null,
    target_value: null,
  },
  {
    id: 'b3',
    placement: 'CAROUSEL',
    image_url: 'https://cdn.test/b3.jpg',
    title: 'Fresh',
    subtitle: null,
    target_type: null,
    target_value: null,
  },
];
const OFFERS: FeaturedOffer[] = [
  {
    id: 'o1',
    placement: 'FEATURED',
    image_url: 'https://cdn.test/o1.jpg',
    title: 'Up to 50% OFF',
    subtitle: 'Groceries',
    target_type: 'CATEGORY',
    target_value: 'groceries',
  },
  {
    id: 'o2',
    placement: 'FEATURED',
    image_url: null,
    title: 'Free delivery',
    subtitle: null,
    target_type: null,
    target_value: null,
  },
];

/** Thamel is nearest (0 km) but slow and costly; New Road (1.285 km) is quick, cheap, rated best. */
const EXTRAS: Record<string, VendorExtras> = {
  [THAMEL_VENDOR.id]: {
    cover_image_url: 'https://cdn.test/thamel.jpg',
    rating_average: 4,
    rating_count: 120,
    locality: null,
    prep_minutes: 30,
    average_cost_npr: 800,
    top_offer: '20% OFF up to Rs. 100',
    offer_tags: ['20% OFF up to Rs. 100'],
    is_sponsored: true,
  },
  [NEW_ROAD_VENDOR.id]: {
    cover_image_url: null,
    rating_average: 4.6,
    rating_count: 40,
    locality: null,
    prep_minutes: 15,
    average_cost_npr: 300,
    top_offer: null,
    offer_tags: [],
    is_sponsored: false,
  },
  [PATAN_VENDOR.id]: { ...NO_VENDOR_EXTRAS, rating_average: 3.9, prep_minutes: 20 },
};
const extrasOf = (vendor: ExtrasSubject): VendorExtras => EXTRAS[vendor.id] ?? NO_VENDOR_EXTRAS;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(homePromotions).mockReturnValue({ banners: BANNERS, offers: OFFERS });
  jest.mocked(vendorExtras).mockImplementation(extrasOf);
});

const shopIds = () =>
  screen.getAllByTestId(/^vendor-card-/).map((card) => card.props.testID as string);
const card = (vendorId: string) => `vendor-card-${vendorId}`;

describe('delivery estimate', () => {
  it('adds travel time to the preparation time and shows it as a ten-minute window', () => {
    expect(estimatedDeliveryMinutes(30, 0)).toBe(30);
    expect(estimatedDeliveryMinutes(15, 1.285)).toBe(19);
    expect(deliveryWindow(30, 0)).toEqual({ min: 30, max: 40 });
    expect(deliveryWindow(15, 1.285)).toEqual({ min: 20, max: 30 });
    expect(deliveryWindow(31, 3)).toEqual({ min: 40, max: 50 });
  });

  it('is unknown while the shop has no preparation time', () => {
    expect(estimatedDeliveryMinutes(null, 2)).toBeNull();
    expect(deliveryWindow(null, 2)).toBeNull();
  });
});

describe('the temporary mock source', () => {
  const subject = (id: string, business_name = 'Some Shop'): ExtrasSubject => ({
    id,
    business_name,
  });

  it('serves banners and offers in a development build', () => {
    expect(realMocks.PROMO_MOCKS_ENABLED).toBe(true);
    expect(realMocks.homePromotions(undefined).banners.length).toBeGreaterThan(1);
    expect(realMocks.homePromotions(undefined).offers.length).toBeGreaterThan(0);
  });

  it('gives a shop the same plausible values every time', () => {
    const first = realMocks.vendorExtras(subject(THAMEL_VENDOR.id));

    expect(realMocks.vendorExtras(subject(THAMEL_VENDOR.id))).toEqual(first);
    for (const vendorId of [THAMEL_VENDOR.id, NEW_ROAD_VENDOR.id, PATAN_VENDOR.id, 'vendor-1']) {
      const extras = realMocks.vendorExtras(subject(vendorId));
      expect(extras.prep_minutes).toBeGreaterThanOrEqual(15);
      expect(extras.average_cost_npr).toBeGreaterThan(0);
      expect(extras.offer_tags).toEqual(extras.top_offer === null ? [] : [extras.top_offer]);
      if (extras.rating_average !== null) {
        expect(extras.rating_average).toBeGreaterThanOrEqual(1);
        expect(extras.rating_average).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe('BannerCarousel', () => {
  it('renders nothing at all without banners', () => {
    renderWithProviders(<BannerCarousel banners={[]} onOpen={jest.fn()} />);

    expect(screen.queryByTestId('banner-carousel')).toBeNull();
  });

  it('shows every banner with its text and one dot each', () => {
    renderWithProviders(<BannerCarousel banners={BANNERS} onOpen={jest.fn()} />);

    expect(screen.getByText('Dashain offers')).toBeOnTheScreen();
    expect(screen.getByText('Festive deals')).toBeOnTheScreen();
    expect(screen.getByTestId('banner-b2')).toBeOnTheScreen();
    expect(screen.getAllByTestId('banner-dot-active')).toHaveLength(1);
    expect(screen.getAllByTestId('banner-dot')).toHaveLength(2);
  });

  it('opens a banner that leads somewhere, and only such a banner', () => {
    const onOpen = jest.fn();
    renderWithProviders(<BannerCarousel banners={BANNERS} onOpen={onOpen} />);

    fireEvent.press(screen.getByTestId('banner-b2'));
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: 'Dashain offers' }));
    expect(onOpen).toHaveBeenCalledWith({ type: 'SHOP', value: THAMEL_VENDOR.id });
  });

  describe('auto-scroll', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    const spyScrollTo = () =>
      jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
    const tick = () => {
      act(() => {
        jest.advanceTimersByTime(BANNER_INTERVAL_MS);
      });
    };

    it('moves one page per interval and wraps to the first banner', () => {
      const scrollTo = spyScrollTo();
      renderWithProviders(<BannerCarousel banners={BANNERS} onOpen={jest.fn()} />);

      tick();
      tick();
      tick();

      // The test screen is 750 px wide (React Native's Jest default).
      expect(scrollTo.mock.calls.map(([target]) => target)).toEqual([
        { x: 750, animated: true },
        { x: 1500, animated: true },
        { x: 0, animated: true },
      ]);
    });

    it('waits while the customer is dragging, then continues from where they left it', () => {
      const scrollTo = spyScrollTo();
      renderWithProviders(<BannerCarousel banners={BANNERS} onOpen={jest.fn()} />);
      const scroll = screen.getByTestId('banner-scroll');

      fireEvent(scroll, 'scrollBeginDrag');
      tick();
      expect(scrollTo).not.toHaveBeenCalled();

      fireEvent.scroll(scroll, { nativeEvent: { contentOffset: { x: 1500, y: 0 } } });
      fireEvent(scroll, 'scrollEndDrag');
      expect(screen.getAllByTestId('banner-dot')).toHaveLength(2);
      tick();

      expect(scrollTo).toHaveBeenCalledWith({ x: 0, animated: true });
    });

    it('does not scroll a single banner, and shows no dots for it', () => {
      const scrollTo = spyScrollTo();
      renderWithProviders(<BannerCarousel banners={BANNERS.slice(0, 1)} onOpen={jest.fn()} />);

      tick();

      expect(scrollTo).not.toHaveBeenCalled();
      expect(screen.queryByTestId('banner-dots')).toBeNull();
    });
  });
});

describe('FeaturedOffers', () => {
  it('renders nothing, not even its heading, without offers', () => {
    renderWithProviders(<FeaturedOffers offers={[]} onOpen={jest.fn()} />);

    expect(screen.queryByTestId('featured-offers')).toBeNull();
    expect(screen.queryByText('Featured offers')).toBeNull();
  });

  it('lists the offers as tiles and opens the ones that lead somewhere', () => {
    const onOpen = jest.fn();
    renderWithProviders(<FeaturedOffers offers={OFFERS} onOpen={onOpen} />);

    expect(screen.getByText('Featured offers')).toBeOnTheScreen();
    expect(screen.getByText('Up to 50% OFF')).toBeOnTheScreen();
    expect(screen.getByText('Groceries')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('offer-o2'));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('offer-o1'));
    expect(onOpen).toHaveBeenCalledWith({ type: 'CATEGORY', value: 'groceries' });
  });
});

describe('sortFeed', () => {
  const feed = feedResponse();
  const order = (sort: FeedSort) =>
    sortFeed(feed, sort, extrasOf).serviceable.map((entry) => entry.vendor.id);

  it('keeps the server order for Relevance', () => {
    expect(sortFeed(feed, 'relevance', extrasOf)).toBe(feed);
  });

  it.each([
    ['delivery_time', [NEW_ROAD_VENDOR.id, THAMEL_VENDOR.id]],
    ['rating', [NEW_ROAD_VENDOR.id, THAMEL_VENDOR.id]],
    ['cost_low_to_high', [NEW_ROAD_VENDOR.id, THAMEL_VENDOR.id]],
    ['cost_high_to_low', [THAMEL_VENDOR.id, NEW_ROAD_VENDOR.id]],
  ] as const)('orders the shops that deliver by %s', (sort, expected) => {
    expect(order(sort)).toEqual(expected);
  });

  it('never moves a shop out of its section', () => {
    // Patan would win on nothing here, but even a best-rated browse-only shop stays below.
    const best = (vendor: ExtrasSubject): VendorExtras =>
      vendor.id === PATAN_VENDOR.id ? { ...NO_VENDOR_EXTRAS, rating_average: 5 } : extrasOf(vendor);

    const sorted = sortFeed(feed, 'rating', best);

    expect(sorted.serviceable).toHaveLength(2);
    expect(sorted.explore_further.map((entry) => entry.vendor.id)).toEqual([PATAN_VENDOR.id]);
  });

  it('puts shops without the value last, in either direction, and keeps ties in server order', () => {
    const unknownCost = (vendor: ExtrasSubject): VendorExtras =>
      vendor.id === THAMEL_VENDOR.id ? NO_VENDOR_EXTRAS : extrasOf(vendor);
    const ids = (sort: FeedSort, of: (vendor: ExtrasSubject) => VendorExtras) =>
      sortFeed(feed, sort, of).serviceable.map((entry) => entry.vendor.id);

    expect(ids('cost_low_to_high', unknownCost)).toEqual([NEW_ROAD_VENDOR.id, THAMEL_VENDOR.id]);
    expect(ids('cost_high_to_low', unknownCost)).toEqual([NEW_ROAD_VENDOR.id, THAMEL_VENDOR.id]);
    expect(ids('rating', () => NO_VENDOR_EXTRAS)).toEqual([THAMEL_VENDOR.id, NEW_ROAD_VENDOR.id]);
    expect(ids('rating', () => ({ ...NO_VENDOR_EXTRAS, rating_average: 4 }))).toEqual([
      THAMEL_VENDOR.id,
      NEW_ROAD_VENDOR.id,
    ]);
  });
});

describe('SortFilterSheet', () => {
  it('lists the five orders as radio buttons with the current one checked', () => {
    renderWithProviders(
      <SortFilterSheet visible sort="rating" onApply={jest.fn()} onClose={jest.fn()} />,
    );

    expect(
      screen.getAllByRole('radio').map((radio) => radio.props.accessibilityLabel as string),
    ).toEqual(['Relevance', 'Delivery Time', 'Rating', 'Cost: Low to High', 'Cost: High to Low']);
    expect(screen.getByRole('radio', { name: 'Rating' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Relevance' })).not.toBeChecked();
  });

  it('applies a choice only with Apply', () => {
    const onApply = jest.fn();
    renderWithProviders(
      <SortFilterSheet visible sort="relevance" onApply={onApply} onClose={jest.fn()} />,
    );

    fireEvent.press(screen.getByRole('radio', { name: 'Cost: Low to High' }));
    expect(screen.getByRole('radio', { name: 'Cost: Low to High' })).toBeChecked();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith('cost_low_to_high');
  });

  it('goes back to Relevance with Clear Filters, whatever is selected', () => {
    const onApply = jest.fn();
    renderWithProviders(
      <SortFilterSheet visible sort="rating" onApply={onApply} onClose={jest.fn()} />,
    );
    fireEvent.press(screen.getByRole('radio', { name: 'Delivery Time' }));

    fireEvent.press(screen.getByRole('button', { name: 'Clear Filters' }));

    expect(onApply).toHaveBeenCalledWith('relevance');
  });

  it('closes from the backdrop without applying', () => {
    const onApply = jest.fn();
    const onClose = jest.fn();
    renderWithProviders(
      <SortFilterSheet visible sort="relevance" onApply={onApply} onClose={onClose} />,
    );
    fireEvent.press(screen.getByRole('radio', { name: 'Rating' }));

    fireEvent.press(screen.getByTestId('sort-sheet-backdrop'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('is in Nepali under ne', () => {
    renderWithProviders(
      <SortFilterSheet visible sort="relevance" onApply={jest.fn()} onClose={jest.fn()} />,
      { locale: 'ne' },
    );

    expect(screen.getByRole('radio', { name: 'मूल्य: कमदेखि बढी' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'लागू गर्नुहोस्' })).toBeOnTheScreen();
  });
});

describe('VendorCard', () => {
  const entry = feedResponse().serviceable[0];
  if (entry === undefined) throw new Error('the feed fixture has no serviceable shop');

  it('shows the offer as a tag by the delivery details, the rating pill, the time and the distance', () => {
    renderWithProviders(<VendorCard entry={{ ...entry, distance_km: 1.26 }} onPress={jest.fn()} />);
    const shop = within(screen.getByTestId(card(THAMEL_VENDOR.id)));

    expect(shop.getByTestId(`vendor-offer-${THAMEL_VENDOR.id}`)).toHaveTextContent(
      '20% OFF up to Rs. 100',
    );
    // A small tag in the card's body, no longer a headline over the photo.
    expect(
      within(shop.getByTestId(`vendor-cover-${THAMEL_VENDOR.id}`)).queryByText(
        '20% OFF up to Rs. 100',
      ),
    ).toBeNull();
    expect(shop.getByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toHaveTextContent('4');
    expect(shop.getByLabelText('Rated 4 out of 5')).toBeOnTheScreen();
    // 30 min to prepare + 4 min for 1.26 km, rounded up to 35.
    expect(shop.getByText('35–45 mins')).toBeOnTheScreen();
    expect(shop.getByText('1.3 km away')).toBeOnTheScreen();
    expect(shop.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
  });

  it('labels a sponsored shop as an ad on its cover, and no other shop', () => {
    const second = feedResponse().serviceable[1];
    if (second === undefined) throw new Error('the feed fixture has one serviceable shop only');
    renderWithProviders(
      <>
        <VendorCard entry={entry} />
        <VendorCard entry={second} />
      </>,
    );

    const cover = within(screen.getByTestId(`vendor-cover-${THAMEL_VENDOR.id}`));
    expect(cover.getByTestId(`vendor-ad-${THAMEL_VENDOR.id}`)).toHaveTextContent('Ad');
    expect(cover.getByLabelText('Sponsored')).toBeOnTheScreen();
    expect(screen.queryByTestId(`vendor-ad-${NEW_ROAD_VENDOR.id}`)).toBeNull();
  });

  it('leaves out whatever the shop has no value for', () => {
    jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
    renderWithProviders(<VendorCard entry={entry} onPress={jest.fn()} />);

    expect(screen.queryByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toBeNull();
    expect(screen.queryByTestId(`vendor-offer-${THAMEL_VENDOR.id}`)).toBeNull();
    expect(screen.queryByTestId(`vendor-eta-${THAMEL_VENDOR.id}`)).toBeNull();
    expect(screen.queryByTestId(`vendor-ad-${THAMEL_VENDOR.id}`)).toBeNull();
    expect(screen.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(screen.getByText('0 km away')).toBeOnTheScreen();
  });

  it('promises no delivery time for a shop that does not deliver here', () => {
    renderWithProviders(
      <VendorCard entry={{ ...entry, serviceable: false }} onPress={jest.fn()} />,
    );

    expect(screen.queryByTestId(`vendor-eta-${THAMEL_VENDOR.id}`)).toBeNull();
    expect(screen.getByText("Doesn't deliver to you")).toBeOnTheScreen();
  });

  it('writes the rating and the time in Devanagari under ne', () => {
    renderWithProviders(<VendorCard entry={entry} />, { locale: 'ne' });

    expect(screen.getByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toHaveTextContent('४');
    expect(screen.getByText('३०–४० मिनेट')).toBeOnTheScreen();
  });
});

describe('Home: promotions and the sort sheet', () => {
  beforeEach(() => {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
  });

  it('shows the banners and the offers above the shops', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    expect(within(screen.getByTestId('banner-carousel')).getByText('Dashain offers')).toBeTruthy();
    expect(within(screen.getByTestId('featured-offers')).getByText('Up to 50% OFF')).toBeTruthy();
    expect(shopIds()).toHaveLength(3);
  });

  it('collapses both sections when the admin has published nothing', async () => {
    jest.mocked(homePromotions).mockReturnValue(NO_PROMOTIONS);
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    expect(screen.queryByTestId('banner-carousel')).toBeNull();
    expect(screen.queryByTestId('featured-offers')).toBeNull();
    expect(screen.queryByText('Featured offers')).toBeNull();
    // The rest of Home is as before.
    expect(screen.getByRole('button', { name: 'Filter' })).toBeOnTheScreen();
    expect(shopIds()).toHaveLength(3);
  });

  it('opens the shop a banner points at', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    fireEvent.press(screen.getByRole('button', { name: 'Dashain offers' }));

    expect(jest.mocked(router.push)).toHaveBeenCalledWith({
      pathname: '/vendor/[id]',
      params: { id: THAMEL_VENDOR.id },
    });
  });

  it('hides the promotions while searching', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByTestId('banner-carousel');

    fireEvent.changeText(screen.getByTestId('product-search'), 'tea');

    expect(screen.queryByTestId('banner-carousel')).toBeNull();
    expect(screen.queryByTestId('featured-offers')).toBeNull();
    expect(screen.queryByTestId('feed-filter-button')).toBeNull();
  });

  it('reorders the shops once a sort is applied, keeping Explore Further last', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    expect(shopIds()).toEqual([
      card(THAMEL_VENDOR.id),
      card(NEW_ROAD_VENDOR.id),
      card(PATAN_VENDOR.id),
    ]);

    fireEvent.press(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.press(screen.getByRole('radio', { name: 'Rating' }));
    // Not applied yet.
    expect(shopIds()[0]).toBe(card(THAMEL_VENDOR.id));
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));

    expect(shopIds()).toEqual([
      card(NEW_ROAD_VENDOR.id),
      card(THAMEL_VENDOR.id),
      card(PATAN_VENDOR.id),
    ]);
    expect(screen.queryByTestId('sort-sheet')).toBeNull();
    expect(screen.getByTestId('feed-sort-chip')).toHaveTextContent('Rating');
  });

  it('sorts by cost in both directions', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    const apply = (label: string) => {
      fireEvent.press(screen.getByRole('button', { name: 'Filter' }));
      fireEvent.press(screen.getByRole('radio', { name: label }));
      fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    };

    apply('Cost: Low to High');
    expect(shopIds().slice(0, 2)).toEqual([card(NEW_ROAD_VENDOR.id), card(THAMEL_VENDOR.id)]);

    apply('Cost: High to Low');
    expect(shopIds().slice(0, 2)).toEqual([card(THAMEL_VENDOR.id), card(NEW_ROAD_VENDOR.id)]);
  });

  it('reopens on the applied order and returns to Relevance with Clear Filters', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    fireEvent.press(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.press(screen.getByRole('radio', { name: 'Delivery Time' }));
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(shopIds()[0]).toBe(card(NEW_ROAD_VENDOR.id));

    fireEvent.press(screen.getByRole('button', { name: 'Filter' }));
    expect(screen.getByRole('radio', { name: 'Delivery Time' })).toBeChecked();
    fireEvent.press(screen.getByRole('button', { name: 'Clear Filters' }));

    expect(shopIds()[0]).toBe(card(THAMEL_VENDOR.id));
    expect(screen.queryByTestId('feed-sort-chip')).toBeNull();
  });

  it('drops the sort from its chip, and a sheet closed from the backdrop changes nothing', async () => {
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    fireEvent.press(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.press(screen.getByRole('radio', { name: 'Rating' }));
    fireEvent.press(screen.getByTestId('sort-sheet-backdrop'));
    expect(shopIds()[0]).toBe(card(THAMEL_VENDOR.id));

    fireEvent.press(screen.getByRole('button', { name: 'Filter' }));
    // The abandoned choice is forgotten.
    expect(screen.getByRole('radio', { name: 'Relevance' })).toBeChecked();
    fireEvent.press(screen.getByRole('radio', { name: 'Rating' }));
    fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(shopIds()[0]).toBe(card(NEW_ROAD_VENDOR.id));

    fireEvent.press(screen.getByRole('button', { name: 'Remove sorting by Rating' }));

    expect(shopIds()[0]).toBe(card(THAMEL_VENDOR.id));
  });
});

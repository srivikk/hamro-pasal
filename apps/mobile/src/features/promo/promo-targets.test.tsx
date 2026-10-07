import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import { SectionList } from 'react-native';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import { CATEGORIES_PATH, PRODUCTS_PATH, VENDORS_PATH } from '../../api/catalog';
import { useToastStore } from '../../store/useToastStore';
import {
  categoryList,
  ELECTRONICS_ID,
  feedResponse,
  feedVendor,
  GROCERIES_ID,
  NEW_ROAD_VENDOR,
  PATAN_VENDOR,
  productList,
  publicProduct,
  TEA_COFFEE_ID,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { findCategoryByTarget } from '../discovery/discovery-rules';
import { vendorIdsWithOfferTag } from '../feed/feed-sort';
import type * as MockPromotionsModule from './mock-promotions';
import { homePromotions, vendorExtras } from './mock-promotions';
import {
  hasOfferTag,
  NO_VENDOR_EXTRAS,
  PROMO_TARGET_TYPES,
  promoTarget,
  type ExtrasSubject,
  type FeaturedOffer,
  type PromoBanner,
  type Promotion,
  type PromoTargetType,
  type VendorExtras,
} from './promo-model';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('./mock-promotions', () => ({
  PROMO_MOCKS_ENABLED: true,
  homePromotions: jest.fn(),
  vendorExtras: jest.fn(),
}));

setupApiTestEnvironment();

const realMocks = jest.requireActual<typeof MockPromotionsModule>('./mock-promotions');

const banner = (
  id: string,
  title: string,
  target_type: PromoTargetType | null,
  target_value: string | null,
): PromoBanner => ({
  id,
  placement: 'CAROUSEL',
  image_url: `https://cdn.test/${id}.jpg`,
  title,
  subtitle: null,
  target_type,
  target_value,
});
const offer = (
  id: string,
  title: string,
  target_type: PromoTargetType | null,
  target_value: string | null,
): FeaturedOffer => ({
  id,
  placement: 'FEATURED',
  image_url: null,
  title,
  subtitle: null,
  target_type,
  target_value,
});

const BANNERS = [
  banner('shop', 'Visit New Road', 'SHOP', NEW_ROAD_VENDOR.id),
  banner('category', 'Gadget week', 'CATEGORY', 'electronics'),
  banner('tag', 'Ten percent week', 'DISCOUNT_TAG', '10% OFF'),
];
const OFFERS = [
  // By display name and in another case: still the Electronics category.
  offer('category-name', 'All electronics', 'CATEGORY', 'ELECTRONICS'),
  offer('subcategory', 'Tea time', 'CATEGORY', 'tea-coffee'),
  offer('tag-case', 'Delivery on us', 'DISCOUNT_TAG', ' free delivery '),
  offer('tag-nobody', 'Mega deal', 'DISCOUNT_TAG', 'Mega Deal'),
  offer('category-gone', 'Old campaign', 'CATEGORY', 'toys'),
  offer('shop-offer', 'Thamel Kirana', 'SHOP', THAMEL_VENDOR.id),
];

/** Thamel (delivers) and Patan (browse only) carry "10% OFF"; New Road (delivers) "Free delivery". */
const TAGS: Record<string, string[]> = {
  [THAMEL_VENDOR.id]: ['10% OFF'],
  [NEW_ROAD_VENDOR.id]: ['Free delivery'],
  [PATAN_VENDOR.id]: ['10% OFF', 'Dashain Sale'],
};
const extrasOf = (vendor: ExtrasSubject): VendorExtras => ({
  ...NO_VENDOR_EXTRAS,
  offer_tags: TAGS[vendor.id] ?? [],
});

const card = (vendorId: string) => `vendor-card-${vendorId}`;
const shopIds = () =>
  screen.getAllByTestId(/^vendor-card-/).map((shop) => shop.props.testID as string);
const HEADER_HEIGHT = 520;
/** What the device does once the list's header (banners, offers, categories) is laid out. */
const layOutHeader = () => {
  fireEvent(screen.getByTestId('feed-header'), 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 390, height: HEADER_HEIGHT } },
  });
};

// Under Jest a list has no scroll responder, so the test supplies one and watches its scrollTo.
const scrollTo = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(homePromotions).mockReturnValue({ banners: BANNERS, offers: OFFERS });
  jest.mocked(vendorExtras).mockImplementation(extrasOf);
  jest
    .spyOn(SectionList.prototype, 'getScrollResponder')
    .mockReturnValue({ scrollTo } as unknown as ReturnType<SectionList['getScrollResponder']>);
  // Electronics is sold by New Road only; Tea & Coffee (under Groceries) by Thamel only.
  const sellers: Record<string, string[]> = {
    [ELECTRONICS_ID]: [NEW_ROAD_VENDOR.id],
    [TEA_COFFEE_ID]: [THAMEL_VENDOR.id],
    [GROCERIES_ID]: [THAMEL_VENDOR.id, PATAN_VENDOR.id],
  };
  server.use(
    http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())),
    http.get(apiUrl(CATEGORIES_PATH), () => HttpResponse.json(categoryList())),
    http.get(apiUrl(PRODUCTS_PATH), ({ request }) => {
      const categoryId = new URL(request.url).searchParams.get('category_id') ?? '';
      return HttpResponse.json(
        productList(
          (sellers[categoryId] ?? []).map((vendorId, index) =>
            publicProduct({
              id: `7a2b3c40-0011-4000-8000-0000000000b${String(index)}`,
              vendor: { id: vendorId, business_name: 'Shop' },
              category_id: categoryId,
            }),
          ),
        ),
      );
    }),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function renderHome() {
  renderWithProviders(<FeedScreen />);
  await screen.findByText('Delivers to you');
  await screen.findByTestId('category-carousel');
  layOutHeader();
}

describe('promotion targets (model)', () => {
  const promotion = (target_type: PromoTargetType | null, target_value: string | null): Promotion =>
    banner('x', 'X', target_type, target_value);

  it('has exactly the three target types an admin can choose', () => {
    expect(PROMO_TARGET_TYPES).toEqual(['SHOP', 'DISCOUNT_TAG', 'CATEGORY']);
  });

  it('reads a promotion’s destination, and none when it is incomplete', () => {
    expect(promoTarget(promotion('SHOP', ' abc '))).toEqual({ type: 'SHOP', value: 'abc' });
    expect(promoTarget(promotion('DISCOUNT_TAG', '10% OFF'))).toEqual({
      type: 'DISCOUNT_TAG',
      value: '10% OFF',
    });
    expect(promoTarget(promotion(null, null))).toBeNull();
    expect(promoTarget(promotion('CATEGORY', '   '))).toBeNull();
    expect(promoTarget(promotion('CATEGORY', null))).toBeNull();
    expect(promoTarget(promotion(null, 'festive'))).toBeNull();
  });

  it('finds a category by its slug, or by its name, in any case', () => {
    const { categories } = categoryList();

    expect(findCategoryByTarget(categories, 'electronics')?.id).toBe(ELECTRONICS_ID);
    expect(findCategoryByTarget(categories, ' Electronics ')?.id).toBe(ELECTRONICS_ID);
    expect(findCategoryByTarget(categories, 'tea & coffee')?.id).toBe(TEA_COFFEE_ID);
    expect(findCategoryByTarget(categories, 'toys')).toBeUndefined();
  });

  it('matches an offer label whatever its case and spacing, and only whole labels', () => {
    const extras = { ...NO_VENDOR_EXTRAS, offer_tags: ['10% OFF', 'Free delivery'] };

    expect(hasOfferTag(extras, '10% off')).toBe(true);
    expect(hasOfferTag(extras, ' FREE DELIVERY ')).toBe(true);
    expect(hasOfferTag(extras, '10%')).toBe(false);
    expect(hasOfferTag(NO_VENDOR_EXTRAS, '10% OFF')).toBe(false);
  });

  it('lists the shops of both sections that carry a label', () => {
    const feed = feedResponse();

    expect(vendorIdsWithOfferTag(feed, '10% OFF', extrasOf)).toEqual([
      THAMEL_VENDOR.id,
      PATAN_VENDOR.id,
    ]);
    expect(vendorIdsWithOfferTag(feed, 'Mega Deal', extrasOf)).toEqual([]);
  });
});

describe('the mock promotions and shops', () => {
  const ASAN_ID = '6f1c2a10-0000-4000-8000-0000000000a1';
  const SEEDED_NEW_ROAD_ID = '6f1c2a10-0000-4000-8000-0000000000a2';
  const seededFeed = feedResponse({
    serviceable: [
      {
        vendor: feedVendor({ id: ASAN_ID, business_name: 'Asan Masala & Snacks' }),
        distance_km: 0.8,
        serviceable: true,
      },
    ],
    explore_further: [
      {
        vendor: feedVendor({ id: SEEDED_NEW_ROAD_ID, business_name: 'New Road Electronics' }),
        distance_km: 9,
        serviceable: false,
      },
    ],
  });

  it('uses all three target types across the carousel and the featured row', () => {
    const { banners, offers } = realMocks.homePromotions(seededFeed);
    const types = (list: Promotion[]) => new Set(list.map((entry) => entry.target_type));

    const placements = (list: Promotion[]) => new Set(list.map((entry) => entry.placement));
    expect(placements(banners)).toEqual(new Set(['CAROUSEL']));
    expect(placements(offers)).toEqual(new Set(['FEATURED']));
    expect(types(banners)).toEqual(new Set(['CATEGORY', 'SHOP', 'DISCOUNT_TAG', null]));
    expect(types(offers)).toEqual(new Set(['CATEGORY', 'SHOP', 'DISCOUNT_TAG']));
  });

  it('gives a SHOP promotion the id the feed has for that shop, in either section', () => {
    const { banners, offers } = realMocks.homePromotions(seededFeed);

    expect(banners.find((entry) => entry.target_type === 'SHOP')?.target_value).toBe(ASAN_ID);
    expect(offers.find((entry) => entry.target_type === 'SHOP')?.target_value).toBe(
      SEEDED_NEW_ROAD_ID,
    );
  });

  it('leaves a SHOP promotion out while its shop is not in the feed', () => {
    const before = realMocks.homePromotions(undefined);
    const elsewhere = realMocks.homePromotions(
      feedResponse({
        serviceable: [{ vendor: feedVendor(), distance_km: 0, serviceable: true }],
        explore_further: [],
      }),
    );

    for (const { banners, offers } of [before, elsewhere]) {
      expect([...banners, ...offers].some((entry) => entry.target_type === 'SHOP')).toBe(false);
      expect(banners.length).toBeGreaterThan(1);
    }
  });

  it('points every DISCOUNT_TAG promotion at a label some seeded shop carries', () => {
    const { banners, offers } = realMocks.homePromotions(seededFeed);
    const labels = Object.values(realMocks.MOCK_SHOPS).flatMap((shop) => shop.offer_tags);

    for (const entry of [...banners, ...offers]) {
      if (entry.target_type === 'DISCOUNT_TAG') expect(labels).toContain(entry.target_value);
    }
  });

  it('knows the nine live shops of the development seed by name', () => {
    expect(Object.keys(realMocks.MOCK_SHOPS)).toHaveLength(9);
    const asan = realMocks.vendorExtras({ id: 'any-id', business_name: 'Asan Masala & Snacks' });

    expect(asan).toMatchObject({
      rating_average: 4.7,
      prep_minutes: 10,
      average_cost_npr: 200,
      top_offer: '10% OFF',
      offer_tags: ['10% OFF', 'Dashain Sale'],
      is_sponsored: false,
    });
    const sponsored = Object.entries(realMocks.MOCK_SHOPS)
      .filter(([, shop]) => shop.is_sponsored)
      .map(([name]) => name);
    expect(sponsored).toEqual(['New Road Electronics', 'Jawalakhel Dashain Bazaar']);
    expect(asan.cover_image_url).toMatch(/^https:\/\//);
    // A top offer is always one of the shop's labels.
    for (const shop of Object.values(realMocks.MOCK_SHOPS)) {
      if (shop.top_offer !== null) expect(shop.offer_tags).toContain(shop.top_offer);
    }
  });
});

describe('Home: tapping a promotion', () => {
  it('SHOP: opens that shop’s page, from a banner and from an offer tile', async () => {
    await renderHome();

    fireEvent.press(screen.getByRole('button', { name: 'Visit New Road' }));
    fireEvent.press(screen.getByRole('button', { name: 'Thamel Kirana' }));

    expect(jest.mocked(router.push).mock.calls).toEqual([
      [{ pathname: '/vendor/[id]', params: { id: NEW_ROAD_VENDOR.id } }],
      [{ pathname: '/vendor/[id]', params: { id: THAMEL_VENDOR.id } }],
    ]);
    // Nothing was filtered.
    expect(shopIds()).toHaveLength(3);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('CATEGORY: filters the feed exactly as the category tile does', async () => {
    await renderHome();

    fireEvent.press(screen.getByRole('button', { name: 'Gadget week' }));

    await waitFor(() => {
      expect(shopIds()).toEqual([card(NEW_ROAD_VENDOR.id)]);
    });
    expect(screen.getByTestId(`category-${ELECTRONICS_ID}`)).toBeSelected();
    expect(screen.getByTestId('category-all')).not.toBeSelected();

    // And the tile undoes it.
    fireEvent.press(screen.getByTestId(`category-${ELECTRONICS_ID}`));
    expect(shopIds()).toHaveLength(3);
  });

  it('CATEGORY: scrolls down to the shops once the filtered list is laid out, and only once', async () => {
    await renderHome();

    fireEvent.press(screen.getByRole('button', { name: 'Gadget week' }));
    await waitFor(() => {
      expect(shopIds()).toEqual([card(NEW_ROAD_VENDOR.id)]);
    });
    // The list was rebuilt after the category's shops loaded: nothing to scroll by yet.
    expect(scrollTo).not.toHaveBeenCalled();
    layOutHeader();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: HEADER_HEIGHT, animated: true });

    layOutHeader();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('CATEGORY: accepts the category’s name, and a subcategory that has no tile', async () => {
    await renderHome();

    fireEvent.press(screen.getByTestId('offer-category-name'));
    await waitFor(() => {
      expect(shopIds()).toEqual([card(NEW_ROAD_VENDOR.id)]);
    });

    fireEvent.press(screen.getByTestId('offer-subcategory'));
    await waitFor(() => {
      expect(shopIds()).toEqual([card(THAMEL_VENDOR.id)]);
    });
    expect(screen.getByTestId(`category-${GROCERIES_ID}`)).not.toBeSelected();
  });

  it('CATEGORY: says the offer is unavailable when the category no longer exists', async () => {
    await renderHome();

    fireEvent.press(screen.getByTestId('offer-category-gone'));

    expect(useToastStore.getState().toast).toMatchObject({
      message: "This offer isn't available right now.",
    });
    expect(shopIds()).toHaveLength(3);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('DISCOUNT_TAG: keeps only the shops carrying the label, in both sections, and scrolls to them', async () => {
    await renderHome();

    fireEvent.press(screen.getByRole('button', { name: 'Ten percent week' }));

    expect(shopIds()).toEqual([card(THAMEL_VENDOR.id), card(PATAN_VENDOR.id)]);
    expect(screen.getByTestId(card(PATAN_VENDOR.id))).toBeDisabled();
    expect(screen.getByTestId('feed-tag-chip')).toHaveTextContent('10% OFF');
    // The list was already on screen with a measured header: it scrolls at once.
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: HEADER_HEIGHT, animated: true });
  });

  it('DISCOUNT_TAG: compares labels without regard to case or spaces', async () => {
    await renderHome();

    fireEvent.press(screen.getByTestId('offer-tag-case'));

    expect(shopIds()).toEqual([card(NEW_ROAD_VENDOR.id)]);
  });

  it('DISCOUNT_TAG: is removed from its chip', async () => {
    await renderHome();
    fireEvent.press(screen.getByRole('button', { name: 'Ten percent week' }));

    fireEvent.press(screen.getByRole('button', { name: 'Remove the 10% OFF filter' }));

    expect(shopIds()).toHaveLength(3);
    expect(screen.queryByTestId('feed-tag-chip')).toBeNull();
  });

  it('DISCOUNT_TAG: says so when no nearby shop carries the label, with a way back', async () => {
    await renderHome();

    fireEvent.press(screen.getByTestId('offer-tag-nobody'));

    expect(
      within(screen.getByTestId('tag-empty')).getByText(
        'No shops near you have a "Mega Deal" offer right now.',
      ),
    ).toBeOnTheScreen();
    // The promotions stay on screen above the message.
    expect(screen.getByTestId('banner-carousel')).toBeOnTheScreen();
    fireEvent.press(
      within(screen.getByTestId('tag-empty')).getByRole('button', { name: 'All Shops' }),
    );
    expect(shopIds()).toHaveLength(3);
    expect(screen.queryByTestId('feed-tag-chip')).toBeNull();
  });

  it('one promotion replaces another: a label clears the category and the other way round', async () => {
    await renderHome();
    fireEvent.press(screen.getByRole('button', { name: 'Gadget week' }));
    await waitFor(() => {
      expect(shopIds()).toEqual([card(NEW_ROAD_VENDOR.id)]);
    });

    fireEvent.press(screen.getByRole('button', { name: 'Ten percent week' }));
    expect(shopIds()).toEqual([card(THAMEL_VENDOR.id), card(PATAN_VENDOR.id)]);
    expect(screen.getByTestId('category-all')).toBeSelected();

    fireEvent.press(screen.getByRole('button', { name: 'Gadget week' }));
    await waitFor(() => {
      expect(shopIds()).toEqual([card(NEW_ROAD_VENDOR.id)]);
    });
    expect(screen.queryByTestId('feed-tag-chip')).toBeNull();
  });

  it('a category tile narrows a label filter further', async () => {
    await renderHome();
    fireEvent.press(screen.getByRole('button', { name: 'Ten percent week' }));

    fireEvent.press(screen.getByTestId(`category-${GROCERIES_ID}`));
    await waitFor(() => {
      expect(shopIds()).toEqual([card(THAMEL_VENDOR.id), card(PATAN_VENDOR.id)]);
    });
    expect(screen.getByTestId(`category-${GROCERIES_ID}`)).toBeSelected();

    // New Road sells electronics but has no "10% OFF" label.
    fireEvent.press(screen.getByTestId(`category-${ELECTRONICS_ID}`));
    expect(await screen.findByTestId('tag-empty')).toBeOnTheScreen();
  });
});

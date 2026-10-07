import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';
import { SectionList } from 'react-native';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import VendorMenuScreen from '../../../app/(tabs)/(home)/vendor/[id]';
import { CATEGORIES_PATH, PRODUCTS_PATH, scanProducts, VENDORS_PATH } from '../../api/catalog';
import { useCartStore } from '../../store/useCartStore';
import {
  categoryList,
  ELECTRONICS_ID,
  feedResponse,
  GROCERIES_ID,
  MUSTARD_OIL_ID,
  NEW_ROAD_VENDOR,
  NOODLES,
  PATAN_VENDOR,
  productList,
  publicProduct,
  RICE,
  TEA_COFFEE_ID,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { categoryIcon } from '../discovery/CategoryCarousel';
import { filterFeedByVendors } from '../discovery/category-shops';
import { groupMenu, OTHER_SECTION_KEY } from './menu-sections';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => ({ id: '6f1c2a10-0000-4000-8000-000000000011' }),
  Stack: { Screen: () => null },
}));

setupApiTestEnvironment();

const TITLES = { all: 'All items', other: 'Other' };
const product = (id: string, vendorId: string, categoryId: string | null) =>
  publicProduct({ id, vendor: { id: vendorId, business_name: 'Shop' }, category_id: categoryId });

/** Serves the taxonomy and the product list, recording the query of each product request. */
function serveProducts(respond: (query: Record<string, string>) => Response) {
  const queries: Record<string, string>[] = [];
  server.use(
    http.get(apiUrl(CATEGORIES_PATH), () => HttpResponse.json(categoryList())),
    http.get(apiUrl(PRODUCTS_PATH), ({ request }) => {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      queries.push(query);
      return respond(query);
    }),
  );
  return queries;
}

describe('scanProducts', () => {
  it('reads every page with the largest page size, following the cursor', async () => {
    const queries = serveProducts((query) =>
      query.cursor === undefined
        ? HttpResponse.json(
            productList([product(NOODLES.id, THAMEL_VENDOR.id, GROCERIES_ID)], NOODLES.id),
          )
        : HttpResponse.json(productList([product(RICE.id, THAMEL_VENDOR.id, GROCERIES_ID)])),
    );

    const products = await scanProducts({ vendorId: THAMEL_VENDOR.id });

    expect(products.map((entry) => entry.id)).toEqual([NOODLES.id, RICE.id]);
    expect(queries).toEqual([
      { vendor_id: THAMEL_VENDOR.id, limit: '50' },
      { vendor_id: THAMEL_VENDOR.id, limit: '50', cursor: NOODLES.id },
    ]);
  });

  it('stops after five pages however long the list is', async () => {
    const queries = serveProducts(() =>
      HttpResponse.json(
        productList([product(NOODLES.id, THAMEL_VENDOR.id, GROCERIES_ID)], NOODLES.id),
      ),
    );

    await scanProducts({ categoryId: GROCERIES_ID });

    expect(queries).toHaveLength(5);
  });
});

describe('Home: "What\'s on your mind?" category filter', () => {
  function serveHome(vendorsByCategory: Record<string, string[]>) {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
    return serveProducts((query) =>
      HttpResponse.json(
        productList(
          (vendorsByCategory[query.category_id ?? ''] ?? []).map((vendorId, index) =>
            product(
              `7a2b3c40-0011-4000-8000-0000000000a${String(index)}`,
              vendorId,
              query.category_id ?? null,
            ),
          ),
        ),
      ),
    );
  }
  const shopIds = () =>
    screen.getAllByTestId(/^vendor-card-/).map((card) => card.props.testID as string);

  it('shows the root categories with "All Shops" above the feed', async () => {
    serveHome({});
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    const carousel = within(await screen.findByTestId('category-carousel'));
    expect(carousel.getByText("What's on your mind?")).toBeOnTheScreen();
    expect(carousel.getByRole('button', { name: 'All Shops' })).toBeSelected();
    expect(carousel.getByRole('button', { name: 'Groceries' })).toBeOnTheScreen();
    expect(carousel.getByRole('button', { name: 'Electronics' })).toBeOnTheScreen();
    // A subcategory is not in the row; its products count under its root.
    expect(carousel.queryByRole('button', { name: 'Tea & Coffee' })).toBeNull();
  });

  it('keeps only the shops that sell something in the chosen category, and resets', async () => {
    const queries = serveHome({
      [GROCERIES_ID]: [THAMEL_VENDOR.id, PATAN_VENDOR.id, THAMEL_VENDOR.id],
      [ELECTRONICS_ID]: [NEW_ROAD_VENDOR.id],
    });
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    expect(shopIds()).toHaveLength(3);

    fireEvent.press(await screen.findByTestId(`category-${ELECTRONICS_ID}`));

    await waitFor(() => {
      expect(shopIds()).toEqual([`vendor-card-${NEW_ROAD_VENDOR.id}`]);
    });
    expect(queries).toEqual([{ category_id: ELECTRONICS_ID, limit: '50' }]);
    expect(screen.getByTestId(`category-${ELECTRONICS_ID}`)).toBeSelected();

    fireEvent.press(screen.getByTestId(`category-${GROCERIES_ID}`));
    await waitFor(() => {
      expect(shopIds()).toEqual([
        `vendor-card-${THAMEL_VENDOR.id}`,
        `vendor-card-${PATAN_VENDOR.id}`,
      ]);
    });
    // Still split by delivery: Patan does not deliver here and stays disabled.
    expect(screen.getByTestId(`vendor-card-${PATAN_VENDOR.id}`)).toBeDisabled();

    fireEvent.press(screen.getByTestId('category-all'));
    expect(shopIds()).toHaveLength(3);
  });

  it('clears the filter when the chosen category is tapped again', async () => {
    serveHome({ [ELECTRONICS_ID]: [NEW_ROAD_VENDOR.id] });
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');
    fireEvent.press(await screen.findByTestId(`category-${ELECTRONICS_ID}`));
    await waitFor(() => {
      expect(shopIds()).toHaveLength(1);
    });

    fireEvent.press(screen.getByTestId(`category-${ELECTRONICS_ID}`));

    expect(shopIds()).toHaveLength(3);
    expect(screen.getByTestId('category-all')).toBeSelected();
  });

  it('says so when no nearby shop carries the category, with a way back', async () => {
    serveHome({});
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    fireEvent.press(await screen.findByTestId(`category-${ELECTRONICS_ID}`));

    const empty = within(await screen.findByTestId('category-empty'));
    expect(empty.getByText('No shops near you sell Electronics yet.')).toBeOnTheScreen();
    fireEvent.press(empty.getByRole('button', { name: 'All Shops' }));
    expect(shopIds()).toHaveLength(3);
  });

  it('gives way to the search results while searching', async () => {
    serveHome({});
    renderWithProviders(<FeedScreen />);
    await screen.findByTestId('category-carousel');

    fireEvent.changeText(screen.getByTestId('product-search'), 'tea');

    expect(screen.queryByTestId('category-carousel')).toBeNull();
  });

  it('filters a feed by shop ids, and guesses an icon from a slug', () => {
    const feed = feedResponse();
    expect(filterFeedByVendors(feed, null)).toBe(feed);
    expect(filterFeedByVendors(feed, [PATAN_VENDOR.id])).toMatchObject({
      serviceable: [],
      explore_further: [{ vendor: { id: PATAN_VENDOR.id } }],
    });
    expect([categoryIcon('groceries'), categoryIcon('mens-clothes'), categoryIcon('xyz')]).toEqual([
      'basket',
      'shirt',
      'pricetag',
    ]);
  });
});

describe('groupMenu', () => {
  const categories = categoryList().categories;
  const menu = [
    { id: NOODLES.id, name: 'Noodles', price_npr: 600, in_stock: true, stock_quantity: 20 },
    { id: RICE.id, name: 'Rice', price_npr: 1150, in_stock: true, stock_quantity: 12 },
    { id: MUSTARD_OIL_ID, name: 'Oil', price_npr: 320, in_stock: false, stock_quantity: 0 },
  ];

  it('groups by subcategory in the taxonomy’s order, with unknown products last', () => {
    const sections = groupMenu(
      menu,
      { [NOODLES.id]: ELECTRONICS_ID, [RICE.id]: TEA_COFFEE_ID },
      categories,
      TITLES,
    );

    expect(sections.map((section) => [section.key, section.title, section.data.length])).toEqual([
      [TEA_COFFEE_ID, 'Tea & Coffee', 1],
      [ELECTRONICS_ID, 'Electronics', 1],
      [OTHER_SECTION_KEY, 'Other', 1],
    ]);
  });

  it('is one "All items" section while no category is known', () => {
    expect(groupMenu(menu, undefined, categories, TITLES)).toMatchObject([
      { key: OTHER_SECTION_KEY, title: 'All items', data: menu },
    ]);
    // A category the taxonomy no longer lists counts as unknown.
    expect(groupMenu(menu, { [NOODLES.id]: 'gone' }, categories, TITLES)).toHaveLength(1);
    expect(groupMenu([], {}, categories, TITLES)).toEqual([]);
  });
});

describe('Shop page: subcategory sections and the ITEMS menu', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    serveProducts(() =>
      HttpResponse.json(
        productList([
          product(NOODLES.id, THAMEL_VENDOR.id, GROCERIES_ID),
          product(RICE.id, THAMEL_VENDOR.id, GROCERIES_ID),
          product(MUSTARD_OIL_ID, THAMEL_VENDOR.id, TEA_COFFEE_ID),
        ]),
      ),
    );
  });

  it('lists the products under bold subcategory headers', async () => {
    renderWithProviders(<VendorMenuScreen />);

    const groceries = await screen.findByTestId(`menu-section-${GROCERIES_ID}`);
    expect(within(groceries).getByText('Groceries')).toBeOnTheScreen();
    expect(within(groceries).getByText('2')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId(`menu-section-${TEA_COFFEE_ID}`)).getByText('Tea & Coffee'),
    ).toBeOnTheScreen();
    // Still the same product rows, and adding still works.
    fireEvent.press(screen.getByRole('button', { name: `Add ${NOODLES.name}` }));
    expect(useCartStore.getState().lines).toMatchObject([{ productId: NOODLES.id, quantity: 1 }]);
  });

  it('suggests the shop’s own subcategories in the empty search field, one after another', async () => {
    renderWithProviders(<VendorMenuScreen />);
    await screen.findByTestId(`menu-section-${TEA_COFFEE_ID}`);
    expect(screen.getByTestId('menu-search-hint')).toHaveTextContent('Search for groceries...');

    // Two seconds later (real time here: the page's requests run on real timers).
    await waitFor(
      () => {
        expect(screen.getByTestId('menu-search-hint')).toHaveTextContent(
          'Search for tea & coffee...',
        );
      },
      { timeout: 4000 },
    );

    // Typing puts the suggestion away.
    fireEvent.changeText(screen.getByTestId('menu-search'), 'rice');
    expect(screen.queryByTestId('menu-search-hint')).toBeNull();
  });

  it('opens the ITEMS sheet with each subcategory and its count', async () => {
    renderWithProviders(<VendorMenuScreen />);
    await screen.findByTestId(`menu-section-${GROCERIES_ID}`);

    fireEvent.press(screen.getByRole('button', { name: 'ITEMS' }));

    const sheet = within(screen.getByTestId('menu-sheet'));
    expect(sheet.getByTestId(`menu-jump-${GROCERIES_ID}`)).toHaveTextContent('Groceries(2)');
    expect(sheet.getByTestId(`menu-jump-${TEA_COFFEE_ID}`)).toHaveTextContent('Tea & Coffee(1)');
  });

  it('closes the sheet and scrolls the list to the chosen subcategory', async () => {
    const scrollToLocation = jest
      .spyOn(SectionList.prototype, 'scrollToLocation')
      .mockImplementation(() => undefined);
    renderWithProviders(<VendorMenuScreen />);
    await screen.findByTestId(`menu-section-${GROCERIES_ID}`);
    fireEvent.press(screen.getByTestId('menu-fab'));

    fireEvent.press(screen.getByTestId(`menu-jump-${TEA_COFFEE_ID}`));

    expect(scrollToLocation).toHaveBeenCalledWith({
      sectionIndex: 1,
      itemIndex: 0,
      viewPosition: 0,
      animated: true,
    });
    await waitFor(() => {
      expect(screen.queryByTestId('menu-sheet')).toBeNull();
    });
  });

  it('closes the sheet from the backdrop without scrolling', async () => {
    const scrollToLocation = jest
      .spyOn(SectionList.prototype, 'scrollToLocation')
      .mockImplementation(() => undefined);
    renderWithProviders(<VendorMenuScreen />);
    await screen.findByTestId(`menu-section-${GROCERIES_ID}`);
    fireEvent.press(screen.getByTestId('menu-fab'));

    fireEvent.press(screen.getByTestId('menu-sheet-backdrop'));

    await waitFor(() => {
      expect(screen.queryByTestId('menu-sheet')).toBeNull();
    });
    expect(scrollToLocation).not.toHaveBeenCalled();
  });

  it('falls back to "Search in this shop" while no subcategory is known', async () => {
    server.use(http.get(apiUrl(CATEGORIES_PATH), () => HttpResponse.json(categoryList([]))));
    renderWithProviders(<VendorMenuScreen />);

    await screen.findByTestId(`menu-section-${OTHER_SECTION_KEY}`);
    expect(screen.getByTestId('menu-search-hint')).toHaveTextContent('Search in this shop');
  });

  it('still lists everything, as one section, when the categories cannot be read', async () => {
    server.use(http.get(apiUrl(PRODUCTS_PATH), () => HttpResponse.json({}, { status: 500 })));
    renderWithProviders(<VendorMenuScreen />);

    expect(await screen.findByTestId(`menu-product-${NOODLES.id}`)).toBeOnTheScreen();
    expect(
      within(screen.getByTestId(`menu-section-${OTHER_SECTION_KEY}`)).getByText('All items'),
    ).toBeOnTheScreen();
  });
});

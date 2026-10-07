import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import FeedScreen from '../../../app/(tabs)/(home)/index';
import { CATEGORIES_PATH, PRODUCTS_PATH, VENDORS_PATH } from '../../api/catalog';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  categoryList,
  checkoutResponse,
  errorBody,
  feedResponse,
  HONEY_ID,
  PATAN_VENDOR,
  productList,
  publicProduct,
  TEA_COFFEE_ID,
  TEA_ID,
  THAMEL_VENDOR,
} from '../../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { matchingVendors } from './ProductResults';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

setupApiTestEnvironment();

const queryOf = (request: CapturedRequest) => Object.fromEntries(request.url.searchParams);

/** Serves the feed and the taxonomy, and answers every product request with `respond`. */
function serveCatalog(
  respond: (query: Record<string, string>, call: number) => Response = () =>
    HttpResponse.json(productList()),
) {
  const productRequests: CapturedRequest[] = [];
  let categoryCalls = 0;
  server.use(
    http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())),
    http.get(apiUrl(CATEGORIES_PATH), () => {
      categoryCalls += 1;
      return HttpResponse.json(categoryList());
    }),
    http.get(apiUrl(PRODUCTS_PATH), async ({ request }) => {
      const captured = await capture(request);
      productRequests.push(captured);
      return respond(queryOf(captured), productRequests.length);
    }),
  );
  return { productRequests, categoryCalls: () => categoryCalls };
}

const HONEY = publicProduct({
  id: HONEY_ID,
  name: 'Local Honey 500g',
  description: null,
  price_npr: 900,
  unit: 'jar',
  stock_quantity: 0,
});

/** Products are reached by searching (the category toggle is gone); 'tea' matches no shop name. */
async function searchTea() {
  fireEvent.changeText(await screen.findByTestId('product-search'), 'tea');
}

const card = (productId: string) => screen.getByTestId(`product-card-${productId}`);
const button = (productId: string, name: string) =>
  within(card(productId)).getByRole('button', { name });

describe('Home: product search (GET /api/products?search=)', () => {
  it('searches once typing rests, with the last text typed', async () => {
    const { productRequests } = serveCatalog();
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    const field = screen.getByTestId('product-search');
    for (const text of ['i', 'il', 'ila', 'ilam']) fireEvent.changeText(field, text);

    // The shops give way to a spinner at the first keystroke; no request has left yet.
    expect(screen.getByTestId('products-loading')).toBeOnTheScreen();
    expect(productRequests).toHaveLength(0);

    expect(await screen.findByTestId(`product-card-${TEA_ID}`)).toBeOnTheScreen();
    expect(productRequests.map(queryOf)).toEqual([{ search: 'ilam' }]);
  });

  it('returns to the shops when the field is cleared', async () => {
    serveCatalog();
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    fireEvent.changeText(screen.getByTestId('product-search'), 'tea');
    await screen.findByTestId(`product-card-${TEA_ID}`);
    fireEvent.changeText(screen.getByTestId('product-search'), '');

    expect(screen.getByText('Delivers to you')).toBeOnTheScreen();
    expect(screen.queryByTestId('product-list')).toBeNull();
  });

  it('offers a retry when the products cannot be loaded', async () => {
    const { productRequests } = serveCatalog((_query, call) =>
      call === 1
        ? HttpResponse.json(errorBody('VALIDATION_FAILED'), { status: 400 })
        : HttpResponse.json(productList()),
    );
    renderWithProviders(<FeedScreen />);

    await searchTea();
    expect(
      await screen.findByText("Couldn't load products. Check your connection."),
    ).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId(`product-card-${TEA_ID}`)).toBeOnTheScreen();
    expect(productRequests).toHaveLength(2);
  });

  it('loads the next page at the end of the list', async () => {
    const { productRequests } = serveCatalog((query) =>
      query.cursor === undefined
        ? HttpResponse.json(productList([publicProduct()], TEA_ID))
        : HttpResponse.json(productList([HONEY])),
    );
    renderWithProviders(<FeedScreen />);

    await searchTea();
    await screen.findByTestId(`product-card-${TEA_ID}`);
    fireEvent(screen.getByTestId('product-list'), 'onEndReached');

    expect(await screen.findByTestId(`product-card-${HONEY_ID}`)).toBeOnTheScreen();
    expect(productRequests.map(queryOf)[1]).toEqual({ search: 'tea', cursor: TEA_ID });

    // The last page had no cursor: reaching the end again asks nothing.
    fireEvent(screen.getByTestId('product-list'), 'onEndReached');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(productRequests).toHaveLength(2);
  });

  it('renders prices and stock in Devanagari numerals under ne', async () => {
    serveCatalog(() => HttpResponse.json(productList([publicProduct(), HONEY])));
    renderWithProviders(<FeedScreen />, { locale: 'ne' });

    await searchTea();

    expect(await screen.findByText('रु. ४५० / pack')).toBeOnTheScreen();
    expect(screen.getByText('स्टकमा १२ वटा')).toBeOnTheScreen();
    expect(within(card(HONEY_ID)).getByText('स्टकमा छैन')).toBeOnTheScreen();
  });
});

describe('Home: stock safeguards on the quantity picker', () => {
  async function showProducts(...products: Parameters<typeof productList>[0] & object) {
    serveCatalog(() => HttpResponse.json(productList(products)));
    renderWithProviders(<FeedScreen />);
    await searchTea();
    await screen.findByTestId('product-list');
  }

  it('shows an "Out of Stock" badge and disables adding when stock_quantity is 0', async () => {
    await showProducts(HONEY);

    expect(
      within(screen.getByTestId(`out-of-stock-${HONEY_ID}`)).getByText('Out of Stock'),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId(`stock-${HONEY_ID}`)).toBeNull();
    expect(button(HONEY_ID, 'Add Local Honey 500g')).toBeDisabled();
    expect(button(HONEY_ID, 'Increase quantity of Local Honey 500g')).toBeDisabled();
    expect(button(HONEY_ID, 'Decrease quantity of Local Honey 500g')).toBeDisabled();

    fireEvent.press(button(HONEY_ID, 'Add Local Honey 500g'));
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it('has no badge and an enabled Add button while one unit is left', async () => {
    await showProducts(publicProduct({ stock_quantity: 1 }));

    expect(screen.queryByTestId(`out-of-stock-${TEA_ID}`)).toBeNull();
    expect(within(card(TEA_ID)).getByText('1 in stock')).toBeOnTheScreen();
    expect(button(TEA_ID, 'Add Ilam Tea 500g')).toBeEnabled();
    // One unit: the picker starts at its ceiling.
    expect(button(TEA_ID, 'Increase quantity of Ilam Tea 500g')).toBeDisabled();
  });

  it('stops the stepper at the stock', async () => {
    await showProducts(publicProduct({ stock_quantity: 3 }));
    const plus = button(TEA_ID, 'Increase quantity of Ilam Tea 500g');

    for (let press = 0; press < 6; press += 1) fireEvent.press(plus);

    expect(screen.getByTestId(`quantity-${TEA_ID}`)).toHaveTextContent('3');
    expect(plus).toBeDisabled();

    fireEvent.press(button(TEA_ID, 'Add Ilam Tea 500g'));
    expect(useCartStore.getState().lines).toEqual([
      expect.objectContaining({ productId: TEA_ID, quantity: 3, availableStock: 3 }),
    ]);
  });

  it('adds the picked quantity with the vendor snapshot from the feed', async () => {
    await showProducts(publicProduct());

    fireEvent.press(button(TEA_ID, 'Increase quantity of Ilam Tea 500g'));
    fireEvent.press(button(TEA_ID, 'Add Ilam Tea 500g'));

    expect(useCartStore.getState().vendor).toEqual(THAMEL_VENDOR);
    expect(useCartStore.getState().lines).toEqual([
      {
        productId: TEA_ID,
        name: 'Ilam Tea 500g',
        unitPriceNpr: 450,
        quantity: 2,
        availableStock: 12,
      },
    ]);
    expect(within(card(TEA_ID)).getByText('2 in cart')).toBeOnTheScreen();
    // The picker starts over after an add.
    expect(screen.getByTestId(`quantity-${TEA_ID}`)).toHaveTextContent('1');
  });

  it('counts what the cart already holds against the stock', async () => {
    useCartStore.getState().addItem(
      THAMEL_VENDOR,
      {
        id: TEA_ID,
        name: 'Ilam Tea 500g',
        unitPriceNpr: 450,
        availableStock: 3,
      },
      2,
    );
    await showProducts(publicProduct({ stock_quantity: 3 }));

    // 3 in stock, 2 in the cart: one more, and the picker cannot go past it.
    expect(button(TEA_ID, 'Increase quantity of Ilam Tea 500g')).toBeDisabled();
    fireEvent.press(button(TEA_ID, 'Add Ilam Tea 500g'));

    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 3 });
    expect(button(TEA_ID, 'Add Ilam Tea 500g')).toBeDisabled();
    expect(
      within(card(TEA_ID)).getByText('All the available stock is already in your cart.'),
    ).toBeOnTheScreen();
  });

  it('pulls the picker down when a refetch reports less stock', async () => {
    let stock = 5;
    serveCatalog(() => HttpResponse.json(productList([publicProduct({ stock_quantity: stock })])));
    renderWithProviders(<FeedScreen />);
    await searchTea();
    await screen.findByText('5 in stock');
    for (let press = 0; press < 4; press += 1) {
      fireEvent.press(button(TEA_ID, 'Increase quantity of Ilam Tea 500g'));
    }
    expect(screen.getByTestId(`quantity-${TEA_ID}`)).toHaveTextContent('5');

    stock = 2;
    fireEvent(screen.getByTestId('product-list'), 'refresh');

    expect(await screen.findByText('2 in stock')).toBeOnTheScreen();
    expect(screen.getByTestId(`quantity-${TEA_ID}`)).toHaveTextContent('2');

    stock = 0;
    fireEvent(screen.getByTestId('product-list'), 'refresh');

    // In stock → sold out: the badge appears and adding is switched off.
    expect(await screen.findByTestId(`out-of-stock-${TEA_ID}`)).toBeOnTheScreen();
    expect(button(TEA_ID, 'Add Ilam Tea 500g')).toBeDisabled();
  });

  it('keeps a shop that does not deliver here browse-only', async () => {
    await showProducts(
      publicProduct({
        id: HONEY_ID,
        name: 'Local Honey 500g',
        vendor: { id: PATAN_VENDOR.id, business_name: PATAN_VENDOR.business_name },
        category_id: TEA_COFFEE_ID,
      }),
    );

    expect(button(HONEY_ID, 'Add Local Honey 500g')).toBeDisabled();
    expect(within(card(HONEY_ID)).getByText("Doesn't deliver to you")).toBeOnTheScreen();
  });

  it('lets a guest browse and add to the cart without signing in', async () => {
    useAuthStore.getState().clearSession();
    serveCatalog();
    renderWithProviders(<FeedScreen />);

    await searchTea();

    expect(await screen.findByText('12 in stock')).toBeOnTheScreen();
    expect(within(card(TEA_ID)).queryByTestId(`product-hint-${TEA_ID}`)).toBeNull();
    fireEvent.press(button(TEA_ID, 'Add Ilam Tea 500g'));

    expect(useCartStore.getState().lines).toMatchObject([{ productId: TEA_ID, quantity: 1 }]);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('freezes adding while a checkout is waiting for payment', async () => {
    useCheckoutStore
      .getState()
      .startSession(checkoutResponse({ expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    await showProducts(publicProduct());

    expect(button(TEA_ID, 'Add Ilam Tea 500g')).toBeDisabled();
  });
});

describe('Home: one search for shops and products', () => {
  it('lists the shops whose name matches, even when no product does', async () => {
    serveCatalog(() => HttpResponse.json(productList([])));
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    fireEvent.changeText(screen.getByTestId('product-search'), 'thamel');

    const shops = await screen.findByTestId('shop-results');
    expect(within(shops).getByTestId(`vendor-card-${THAMEL_VENDOR.id}`)).toBeOnTheScreen();
    expect(within(shops).queryByTestId(`vendor-card-${PATAN_VENDOR.id}`)).toBeNull();
    // A shop matched: the "no products" message would be wrong.
    expect(screen.queryByTestId('products-empty')).toBeNull();

    fireEvent.press(within(shops).getByTestId(`vendor-card-${THAMEL_VENDOR.id}`));
    expect(jest.mocked(router.push)).toHaveBeenCalledWith({
      pathname: '/vendor/[id]',
      params: { id: THAMEL_VENDOR.id },
    });
  });

  it('shows matching shops above matching products', async () => {
    serveCatalog(() =>
      HttpResponse.json(productList([publicProduct({ name: 'Organic Honey 500g' })])),
    );
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    fireEvent.changeText(screen.getByTestId('product-search'), 'ORGANIC');

    const shops = await screen.findByTestId('shop-results');
    expect(within(shops).getByTestId(`vendor-card-${PATAN_VENDOR.id}`)).toBeOnTheScreen();
    expect(within(shops).getByText('Products')).toBeOnTheScreen();
    expect(screen.getByText('Organic Honey 500g')).toBeOnTheScreen();
  });

  it('shows only products when no shop name matches', async () => {
    serveCatalog();
    renderWithProviders(<FeedScreen />);
    await screen.findByText('Delivers to you');

    fireEvent.changeText(screen.getByTestId('product-search'), 'ilam');

    expect(await screen.findByTestId(`product-card-${TEA_ID}`)).toBeOnTheScreen();
    expect(screen.queryByTestId('shop-results')).toBeNull();
  });
});

describe('matchingVendors', () => {
  it('matches every word typed, in any case, across both feed sections', () => {
    const feed = feedResponse();
    const names = (text: string) =>
      matchingVendors(feed, text).map((entry) => entry.vendor.business_name);

    expect(names('kirana')).toEqual(['Thamel Kirana Pasal']);
    expect(names('PATAN store')).toEqual(['Patan Organic Store']);
    expect(names('patan kirana')).toEqual([]);
    expect(names('   ')).toEqual([]);
    expect(matchingVendors(undefined, 'thamel')).toEqual([]);
  });
});

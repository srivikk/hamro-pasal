import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import FeedScreen from '../../../app/(tabs)/index';
import { CATEGORIES_PATH, PRODUCTS_PATH, VENDORS_PATH } from '../../api/catalog';
import { useAuthStore } from '../../store/useAuthStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  categoryList,
  checkoutResponse,
  ELECTRONICS_ID,
  errorBody,
  feedResponse,
  GROCERIES_ID,
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

async function openGroceries() {
  fireEvent.press(await screen.findByRole('button', { name: 'Groceries' }));
}

const card = (productId: string) => screen.getByTestId(`product-card-${productId}`);
const button = (productId: string, name: string) =>
  within(card(productId)).getByRole('button', { name });

describe('Home: category pills (GET /api/categories)', () => {
  it('shows the shops first, with one pill per root category', async () => {
    const { productRequests } = serveCatalog();
    renderWithProviders(<FeedScreen />);

    expect(await screen.findByRole('button', { name: 'Groceries' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Electronics' })).toBeOnTheScreen();
    // A subcategory is not a pill; its products are listed under its root.
    expect(screen.queryByRole('button', { name: 'Tea & Coffee' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Shops' })).toBeSelected();

    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();
    expect(productRequests).toHaveLength(0);
  });

  it('filters the products by the chosen category and shows their real data', async () => {
    const { productRequests } = serveCatalog(() =>
      HttpResponse.json(productList([publicProduct(), HONEY])),
    );
    renderWithProviders(<FeedScreen />);

    await openGroceries();

    const tea = await screen.findByTestId(`product-card-${TEA_ID}`);
    expect(productRequests.map(queryOf)).toEqual([{ category_id: GROCERIES_ID }]);
    expect(screen.getByRole('button', { name: 'Groceries' })).toBeSelected();
    expect(screen.queryByText('Delivers to you')).toBeNull();

    expect(within(tea).getByText('Ilam Tea 500g')).toBeOnTheScreen();
    expect(within(tea).getByText('Orthodox black tea from Ilam.')).toBeOnTheScreen();
    expect(within(tea).getByText('Rs. 450 / pack')).toBeOnTheScreen();
    expect(within(tea).getByText('12 in stock')).toBeOnTheScreen();
    expect(within(tea).getByText(THAMEL_VENDOR.name)).toBeOnTheScreen();
    expect(within(card(HONEY_ID)).getByText('Rs. 900 / jar')).toBeOnTheScreen();
  });

  it('asks again when another category is chosen, and returns to the shops', async () => {
    const { productRequests } = serveCatalog((query) =>
      HttpResponse.json(productList(query.category_id === ELECTRONICS_ID ? [] : [publicProduct()])),
    );
    renderWithProviders(<FeedScreen />);

    await openGroceries();
    await screen.findByTestId(`product-card-${TEA_ID}`);
    fireEvent.press(screen.getByRole('button', { name: 'Electronics' }));

    expect(await screen.findByText('No products found.')).toBeOnTheScreen();
    expect(productRequests.map(queryOf)).toEqual([
      { category_id: GROCERIES_ID },
      { category_id: ELECTRONICS_ID },
    ]);

    fireEvent.press(screen.getByRole('button', { name: 'Shops' }));
    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();
    expect(screen.queryByTestId('product-list')).toBeNull();
  });

  it('serves a category chosen again from the cache while it refetches', async () => {
    const { productRequests, categoryCalls } = serveCatalog();
    renderWithProviders(<FeedScreen />);

    await openGroceries();
    await screen.findByTestId(`product-card-${TEA_ID}`);
    fireEvent.press(screen.getByRole('button', { name: 'Shops' }));
    fireEvent.press(screen.getByRole('button', { name: 'Groceries' }));

    // No spinner the second time: the cached page is shown at once and refreshed behind it.
    expect(screen.getByTestId(`product-card-${TEA_ID}`)).toBeOnTheScreen();
    await waitFor(() => {
      expect(productRequests).toHaveLength(2);
    });
    expect(categoryCalls()).toBe(1);
  });

  it('drops a category that left the taxonomy and goes back to the shops', async () => {
    let hidden = false;
    let categoryCalls = 0;
    server.use(
      http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())),
      http.get(apiUrl(CATEGORIES_PATH), () => {
        categoryCalls += 1;
        return HttpResponse.json(
          hidden ? categoryList(categoryList().categories.slice(2)) : categoryList(),
        );
      }),
      http.get(apiUrl(PRODUCTS_PATH), () =>
        HttpResponse.json(errorBody('CATEGORY_NOT_FOUND'), { status: 404 }),
      ),
    );
    renderWithProviders(<FeedScreen />);
    await screen.findByRole('button', { name: 'Groceries' });

    hidden = true;
    fireEvent.press(screen.getByRole('button', { name: 'Groceries' }));

    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Groceries' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Electronics' })).toBeOnTheScreen();
    expect(categoryCalls).toBe(2);
  });

  it('still shows the shops and the search field when the taxonomy cannot be loaded', async () => {
    server.use(
      http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())),
      http.get(apiUrl(CATEGORIES_PATH), () =>
        HttpResponse.json(errorBody('FORBIDDEN'), { status: 403 }),
      ),
    );
    renderWithProviders(<FeedScreen />);

    expect(await screen.findByText('Delivers to you')).toBeOnTheScreen();
    expect(screen.queryByTestId('category-pills')).toBeNull();
    expect(screen.getByTestId('product-search')).toBeOnTheScreen();
  });
});

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

  it('combines the search with the chosen category', async () => {
    const { productRequests } = serveCatalog();
    renderWithProviders(<FeedScreen />);

    await openGroceries();
    await screen.findByTestId(`product-card-${TEA_ID}`);
    fireEvent.changeText(screen.getByTestId('product-search'), 'tea');

    await waitFor(() => {
      expect(productRequests).toHaveLength(2);
    });
    expect(productRequests.map(queryOf)[1]).toEqual({
      category_id: GROCERIES_ID,
      search: 'tea',
    });
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

    await openGroceries();
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

    await openGroceries();
    await screen.findByTestId(`product-card-${TEA_ID}`);
    fireEvent(screen.getByTestId('product-list'), 'onEndReached');

    expect(await screen.findByTestId(`product-card-${HONEY_ID}`)).toBeOnTheScreen();
    expect(productRequests.map(queryOf)[1]).toEqual({
      category_id: GROCERIES_ID,
      cursor: TEA_ID,
    });

    // The last page had no cursor: reaching the end again asks nothing.
    fireEvent(screen.getByTestId('product-list'), 'onEndReached');
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(productRequests).toHaveLength(2);
  });

  it('renders prices and stock in Devanagari numerals under ne', async () => {
    serveCatalog(() => HttpResponse.json(productList([publicProduct(), HONEY])));
    renderWithProviders(<FeedScreen />, { locale: 'ne' });

    fireEvent.press(await screen.findByRole('button', { name: 'Groceries' }));

    expect(await screen.findByText('रु. ४५० / pack')).toBeOnTheScreen();
    expect(screen.getByText('स्टकमा १२ वटा')).toBeOnTheScreen();
    expect(within(card(HONEY_ID)).getByText('स्टकमा छैन')).toBeOnTheScreen();
  });
});

describe('Home: stock safeguards on the quantity picker', () => {
  async function showProducts(...products: Parameters<typeof productList>[0] & object) {
    serveCatalog(() => HttpResponse.json(productList(products)));
    renderWithProviders(<FeedScreen />);
    await openGroceries();
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
    await openGroceries();
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

  it('lets a signed-out visitor browse, and asks them to sign in to order', async () => {
    useAuthStore.getState().clearSession();
    serveCatalog();
    renderWithProviders(<FeedScreen />);

    await openGroceries();

    expect(await screen.findByText('12 in stock')).toBeOnTheScreen();
    expect(button(TEA_ID, 'Add Ilam Tea 500g')).toBeDisabled();
    expect(within(card(TEA_ID)).getByText('Sign in to order.')).toBeOnTheScreen();
  });

  it('freezes adding while a checkout is waiting for payment', async () => {
    useCheckoutStore
      .getState()
      .startSession(checkoutResponse({ expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    await showProducts(publicProduct());

    expect(button(TEA_ID, 'Add Ilam Tea 500g')).toBeDisabled();
  });
});

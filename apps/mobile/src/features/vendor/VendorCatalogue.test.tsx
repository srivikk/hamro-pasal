import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { http, HttpResponse } from 'msw';
import type { CategoryView, VendorProductView } from '@hamro-pasal/shared-types';
import type { ReactElement } from 'react';

import VendorCatalogueScreen from '../../../app/(vendor)/catalogue';
import VendorProductScreen from '../../../app/(vendor)/product';
import { filterOptions } from '../../components/SearchableSelect';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { category, categoryList } from '../../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import { CATEGORIES_QUERY_KEY } from '../discovery/useCategoriesQuery';
import {
  categoryNameOf,
  EMPTY_PRODUCT_FORM,
  productCategoryOptions,
  sanitizeStockInput,
  validateProductForm,
  type ProductForm,
} from './product-form';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
}));

setupApiTestEnvironment();

const toast = () => useToastStore.getState().toast;
const press = (testID: string): void => {
  fireEvent.press(screen.getByTestId(testID));
};
const type = (testID: string, text: string): void => {
  fireEvent.changeText(screen.getByTestId(testID), text);
};
const openProduct = (id?: string): void => {
  jest.mocked(useLocalSearchParams).mockReturnValue(id === undefined ? {} : { id });
};

/** The seeded taxonomy as GET /api/categories serves it: Groceries and its subcategories. */
const catId = (n: number) => `8b3c4d50-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROCERIES = category({ id: catId(1), name: 'Groceries', slug: 'groceries' });
const SUBCATEGORIES: [string, string][] = [
  ['rice-flour-pulses', 'Rice, Flour & Pulses'],
  ['noodles-snacks', 'Noodles & Snacks'],
  ['tea-coffee', 'Tea & Coffee'],
  ['dairy', 'Dairy'],
  ['fresh-vegetables', 'Fresh Vegetables'],
  ['honey-spreads', 'Honey & Spreads'],
];
const TAXONOMY: CategoryView[] = [
  GROCERIES,
  ...SUBCATEGORIES.map(([slug, name], index) =>
    category({ id: catId(index + 2), name, slug, parent_id: GROCERIES.id, display_order: index }),
  ),
];
const OFFERED = productCategoryOptions(TAXONOMY);
const CATEGORY = Object.fromEntries(TAXONOMY.map((row) => [row.slug, row.id])) as Record<
  string,
  string
>;
const RICE = CATEGORY['rice-flour-pulses'] ?? '';
const TEA = CATEGORY['tea-coffee'] ?? '';
const DAIRY = CATEGORY.dairy ?? '';
const HONEY = CATEGORY['honey-spreads'] ?? '';

const productId = (n: number) => `5a0e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RICE_ID = productId(1);
const GHEE_ID = productId(2);
const TEA_ID = productId(3);

function product(overrides: Partial<VendorProductView> = {}): VendorProductView {
  return {
    id: RICE_ID,
    category_id: RICE,
    name: 'Basmati Rice 5kg',
    description: 'Long grain',
    price_npr: 1150,
    unit: 'bag',
    stock_quantity: 12,
    image_urls: [],
    is_active: true,
    metadata: { origin: 'Terai' },
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The server's products for this test, by name; the handlers below read and write it. */
let stored: VendorProductView[] = [];
let requests: CapturedRequest[] = [];
const byName = (a: VendorProductView, b: VendorProductView) => a.name.localeCompare(b.name);
const storedProduct = (id: string) => stored.find((each) => each.id === id);

function serveProducts(): void {
  server.use(
    http.get(apiUrl('/api/vendor/products'), async ({ request }) => {
      requests.push(await capture(request));
      return HttpResponse.json({ products: [...stored].sort(byName), next_cursor: null });
    }),
    http.post(apiUrl('/api/vendor/products'), async ({ request }) => {
      const sent = await capture(request);
      requests.push(sent);
      const body = sent.body as {
        category_id: string;
        name: string;
        price_npr: number;
        stock_quantity: number;
      };
      if (stored.some((each) => each.name.toLowerCase() === body.name.toLowerCase())) {
        return HttpResponse.json(
          { error: { code: 'PRODUCT_NAME_TAKEN', message: 'taken' } },
          { status: 409 },
        );
      }
      const created = product({
        id: productId(50 + stored.length),
        ...body,
        description: null,
        unit: 'piece',
        metadata: {},
      });
      stored.push(created);
      return HttpResponse.json({ product: created }, { status: 201 });
    }),
    http.put(apiUrl('/api/vendor/products/:id'), async ({ request, params }) => {
      const sent = await capture(request);
      requests.push(sent);
      const current = storedProduct(String(params.id));
      if (current === undefined) {
        return HttpResponse.json(
          { error: { code: 'PRODUCT_NOT_FOUND', message: 'gone' } },
          { status: 404 },
        );
      }
      Object.assign(current, sent.body);
      return HttpResponse.json({ product: current });
    }),
    http.patch(apiUrl('/api/vendor/products/:id/stock'), async ({ request, params }) => {
      const sent = await capture(request);
      requests.push(sent);
      const current = storedProduct(String(params.id));
      if (current === undefined) return new HttpResponse(null, { status: 404 });
      current.stock_quantity = (sent.body as { stock_quantity: number }).stock_quantity;
      return HttpResponse.json({ product: current });
    }),
    http.delete(apiUrl('/api/vendor/products/:id'), async ({ request, params }) => {
      requests.push(await capture(request));
      const current = storedProduct(String(params.id));
      if (current !== undefined) current.is_active = false;
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

/** Renders with the taxonomy already loaded, as the app has it once GET /api/categories answered. */
const renderSeller = (
  ui: ReactElement,
  categories: CategoryView[] = TAXONOMY,
  locale: 'en' | 'ne' = 'en',
) => {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(CATEGORIES_QUERY_KEY, categoryList(categories));
  return renderWithProviders(ui, { queryClient, locale });
};

/** The catalogue, loaded; for the form, the cached list it reads the product from. */
async function renderCatalogue(categories: CategoryView[] = TAXONOMY, locale: 'en' | 'ne' = 'en') {
  const view = renderSeller(<VendorCatalogueScreen />, categories, locale);
  await screen.findByTestId('catalogue-list');
  return view;
}

const form = (overrides: Partial<ProductForm> = {}): ProductForm => ({
  name: 'Local Honey 500g',
  price: '900',
  categoryId: HONEY,
  stock: '8',
  ...overrides,
});

beforeEach(() => {
  stored = [
    product(),
    product({
      id: GHEE_ID,
      name: 'DDC Ghee 500ml',
      category_id: DAIRY,
      price_npr: 750,
      stock_quantity: 8,
      is_active: false,
    }),
    product({
      id: TEA_ID,
      name: 'Ilam Tea 500g',
      category_id: TEA,
      price_npr: 450,
      stock_quantity: 30,
    }),
    product({
      id: productId(4),
      name: 'Wai Wai Noodles (pack of 30)',
      category_id: CATEGORY['noodles-snacks'] ?? '',
      price_npr: 600,
      stock_quantity: 0,
    }),
  ];
  requests = [];
  serveProducts();
  useAuthStore.getState().setLocale('en');
  useToastStore.setState({ toast: null });
  jest.mocked(router.push).mockClear();
  jest.mocked(router.navigate).mockClear();
  openProduct();
});

describe('product form rules', () => {
  it('builds a product from a complete form, trimming the name', () => {
    expect(
      validateProductForm(form({ name: '  Local   Honey 500g ', price: '899.50' }), [], OFFERED),
    ).toEqual({
      ok: true,
      details: { name: 'Local Honey 500g', priceNpr: 899.5, categoryId: HONEY, stockQuantity: 8 },
    });
  });

  it('reports every missing or bad field of an empty form', () => {
    expect(validateProductForm({ ...EMPTY_PRODUCT_FORM, stock: '' }, [], OFFERED)).toEqual({
      ok: false,
      errors: { name: 'name', price: 'price', categoryId: 'category', stock: 'stock' },
    });
  });

  it.each(['0', '-5', '1000000.01', '12.345', 'free'])('refuses %p as a price', (price) => {
    expect(validateProductForm(form({ price }), [], OFFERED)).toEqual({
      ok: false,
      errors: { price: 'price' },
    });
  });

  it('takes 0 as a stock quantity (a product can be listed sold out)', () => {
    expect(validateProductForm(form({ stock: '0' }), [], OFFERED)).toMatchObject({
      ok: true,
      details: { stockQuantity: 0 },
    });
  });

  it('refuses a category that is not on the list', () => {
    expect(validateProductForm(form({ categoryId: catId(99) }), [], OFFERED)).toEqual({
      ok: false,
      errors: { categoryId: 'category' },
    });
  });

  it('refuses a name another product of the shop already has, in any letter case', () => {
    expect(validateProductForm(form(), ['local honey 500G'], OFFERED)).toEqual({
      ok: false,
      errors: { name: 'nameTaken' },
    });
  });

  it('keeps digits only in the stock field, converting Nepali digits', () => {
    expect(sanitizeStockInput('1२ pcs')).toBe('12');
  });
});

describe('the searchable list', () => {
  const options = [
    { value: 'a', label: 'Kathmandu Metropolitan City' },
    { value: 'b', label: 'Lalitpur Metropolitan City' },
    { value: 'c', label: 'Kirtipur Municipality' },
  ];

  it('keeps the options containing every word typed, in any case', () => {
    expect(filterOptions(options, '')).toBe(options);
    expect(filterOptions(options, 'METRO lalit').map((option) => option.value)).toEqual(['b']);
    expect(filterOptions(options, 'pur').map((option) => option.value)).toEqual(['b', 'c']);
    expect(filterOptions(options, 'pokhara')).toEqual([]);
  });
});

describe('Catalogue tab (GET /api/vendor/products)', () => {
  it("lists the shop's products from the server, with name, category, price and stock", async () => {
    await renderCatalogue();

    expect(requests[0]).toMatchObject({ method: 'GET' });
    expect(requests[0]?.url.searchParams.get('limit')).toBe('50');
    expect(requests[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    const row = within(screen.getByTestId(`product-${RICE_ID}`));
    expect(row.getByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(row.getByText('Rice, Flour & Pulses')).toBeOnTheScreen();
    expect(row.getByText('Rs. 1150')).toBeOnTheScreen();
    expect(screen.getByTestId(`product-stock-${RICE_ID}`)).toHaveTextContent('In stock: 12');
    expect(screen.getByTestId(`product-listed-switch-${RICE_ID}`).props.value).toBe(true);
    // Nothing on the device invents products.
    expect(screen.queryByText(/sample/i)).not.toBeOnTheScreen();
  });

  it('shows the empty state when the shop has no product yet (a wiped database)', async () => {
    stored = [];
    await renderCatalogue();

    expect(screen.getByTestId('catalogue-empty')).toHaveTextContent(
      'Your catalogue is empty. Add your first product.',
    );
    expect(screen.getByTestId('catalogue-add')).toBeOnTheScreen();
  });

  it('shows a loading state, then an error with a retry when the list cannot be loaded', async () => {
    server.use(
      http.get(apiUrl('/api/vendor/products'), () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'x' } }, { status: 403 }),
      ),
    );
    renderSeller(<VendorCatalogueScreen />);
    expect(screen.getByTestId('catalogue-loading')).toBeOnTheScreen();

    expect(await screen.findByTestId('catalogue-load-error')).toBeOnTheScreen();

    serveProducts();
    fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByTestId('catalogue-list')).toBeOnTheScreen();
  });

  it('marks a hidden product and one with no stock left', async () => {
    await renderCatalogue();

    expect(screen.getByTestId(`product-stock-${GHEE_ID}`)).toHaveTextContent(
      'Hidden from customers',
    );
    expect(screen.getByTestId(`product-listed-switch-${GHEE_ID}`).props.value).toBe(false);
    expect(screen.getByTestId(`product-stock-${productId(4)}`)).toHaveTextContent('No stock left');
  });

  it('hides a product with DELETE and shows it again with a PUT that keeps its details', async () => {
    await renderCatalogue();

    fireEvent(screen.getByTestId(`product-listed-switch-${RICE_ID}`), 'valueChange', false);
    await waitFor(() => {
      expect(screen.getByTestId(`product-stock-${RICE_ID}`)).toHaveTextContent(
        'Hidden from customers',
      );
    });
    expect(requests.find((each) => each.method === 'DELETE')?.url.pathname).toBe(
      `/api/vendor/products/${RICE_ID}`,
    );
    expect(storedProduct(RICE_ID)?.stock_quantity).toBe(12); // the count is kept

    fireEvent(screen.getByTestId(`product-listed-switch-${RICE_ID}`), 'valueChange', true);
    await waitFor(() => {
      expect(screen.getByTestId(`product-stock-${RICE_ID}`)).toHaveTextContent('In stock: 12');
    });
    // The PUT replaces every detail: what the app does not edit is sent back as it was.
    expect(requests.find((each) => each.method === 'PUT')?.body).toEqual({
      category_id: RICE,
      name: 'Basmati Rice 5kg',
      description: 'Long grain',
      price_npr: 1150,
      unit: 'bag',
      is_active: true,
      metadata: { origin: 'Terai' },
    });
  });

  it('opens the editor instead of showing a product that has no category yet', async () => {
    stored.push(
      product({ id: productId(9), name: 'Old Product', category_id: null, is_active: false }),
    );
    await renderCatalogue();

    fireEvent(screen.getByTestId(`product-listed-switch-${productId(9)}`), 'valueChange', true);

    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/product',
      params: { id: productId(9) },
    });
    expect(requests.some((each) => each.method === 'PUT')).toBe(false);
  });

  it('says so when the switch could not be changed', async () => {
    server.use(
      http.delete(apiUrl('/api/vendor/products/:id'), () =>
        HttpResponse.json(
          { error: { code: 'INTERNAL_SERVER_ERROR', message: 'x' } },
          { status: 500 },
        ),
      ),
    );
    await renderCatalogue();

    fireEvent(screen.getByTestId(`product-listed-switch-${RICE_ID}`), 'valueChange', false);

    await waitFor(() => {
      expect(toast()).toMatchObject({
        message: "Couldn't change this product. Try again.",
        tone: 'error',
      });
    });
    expect(screen.getByTestId(`product-listed-switch-${RICE_ID}`).props.value).toBe(true);
  });

  it('opens a new product from the Add button and an existing one from its row', async () => {
    await renderCatalogue();

    press('catalogue-add');
    expect(router.push).toHaveBeenLastCalledWith('/product');

    press(`product-edit-${TEA_ID}`);
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/product', params: { id: TEA_ID } });
  });

  it('shows Nepali digits under ne', async () => {
    await renderCatalogue(TAXONOMY, 'ne');
    expect(screen.getByTestId(`product-stock-${RICE_ID}`)).toHaveTextContent('स्टकमा: १२');
  });
});

describe('product form screen', () => {
  it('adds a product with POST /api/vendor/products: name, price, category id and stock', async () => {
    renderSeller(<VendorProductScreen />);
    expect(screen.getByTestId('product-form-title')).toHaveTextContent('New product');

    type('product-name', 'Local Honey 500g');
    type('product-price', '900');
    press('product-category');
    type('product-category-search', 'honey');
    expect(screen.queryByTestId(`product-category-option-${DAIRY}`)).not.toBeOnTheScreen();
    press(`product-category-option-${HONEY}`);
    expect(screen.getByTestId('product-category')).toHaveTextContent('Honey & Spreads');
    type('product-stock', '8');
    press('product-save');

    await waitFor(() => {
      expect(router.navigate).toHaveBeenCalledWith('/catalogue');
    });
    expect(requests.find((each) => each.method === 'POST')?.body).toMatchObject({
      category_id: HONEY,
      name: 'Local Honey 500g',
      price_npr: 900,
      stock_quantity: 8,
      image_urls: [],
    });
    expect(stored.find((each) => each.name === 'Local Honey 500g')).toBeDefined();
    expect(toast()).toMatchObject({ message: 'Product added.', tone: 'success' });
  });

  it('sends nothing and marks the fields while the form is incomplete', () => {
    renderSeller(<VendorProductScreen />);

    press('product-save');

    expect(screen.getByTestId('product-name-error')).toHaveTextContent('Enter a product name.');
    expect(screen.getByTestId('product-price-error')).toHaveTextContent('Enter a price above 0.');
    expect(screen.getByTestId('product-category-error')).toHaveTextContent('Choose a category.');
    expect(requests.some((each) => each.method === 'POST')).toBe(false);
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows the server's PRODUCT_NAME_TAKEN on the name field", async () => {
    renderSeller(<VendorProductScreen />);
    type('product-name', 'ilam tea 500g');
    type('product-price', '400');
    press('product-category');
    press(`product-category-option-${TEA}`);

    press('product-save');

    expect(await screen.findByTestId('product-name-error')).toHaveTextContent(
      'You already have a product with this name.',
    );
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('edits a product from the server: PUT for the details, PATCH …/stock for a new count', async () => {
    const view = await renderCatalogue();
    openProduct(TEA_ID);
    view.rerender(<VendorProductScreen />);
    expect(screen.getByTestId('product-form-title')).toHaveTextContent('Edit product');
    expect(screen.getByTestId('product-name')).toHaveDisplayValue('Ilam Tea 500g');
    expect(screen.getByTestId('product-price')).toHaveDisplayValue('450');
    expect(screen.getByTestId('product-category')).toHaveTextContent('Tea & Coffee');
    expect(screen.getByTestId('product-stock')).toHaveDisplayValue('30');

    type('product-price', '475');
    type('product-stock', '२५');
    press('product-save');

    await waitFor(() => {
      expect(toast()?.message).toBe('Product updated.');
    });
    expect(storedProduct(TEA_ID)).toMatchObject({ price_npr: 475, stock_quantity: 25 });
    const put = requests.find((each) => each.method === 'PUT');
    expect(put?.url.pathname).toBe(`/api/vendor/products/${TEA_ID}`);
    expect(put?.body).not.toHaveProperty('stock_quantity');
    expect(requests.find((each) => each.method === 'PATCH')?.body).toEqual({ stock_quantity: 25 });
  });

  it('sends no stock PATCH when the count is unchanged', async () => {
    const view = await renderCatalogue();
    openProduct(TEA_ID);
    view.rerender(<VendorProductScreen />);

    type('product-price', '460');
    press('product-save');

    await waitFor(() => {
      expect(toast()?.message).toBe('Product updated.');
    });
    expect(requests.some((each) => each.method === 'PATCH')).toBe(false);
  });

  it('starts a fresh form when the route is reused for another product', async () => {
    const view = await renderCatalogue();
    openProduct(TEA_ID);
    view.rerender(<VendorProductScreen />);
    expect(screen.getByTestId('product-name')).toHaveDisplayValue('Ilam Tea 500g');

    openProduct();
    view.rerender(<VendorProductScreen />);

    expect(screen.getByTestId('product-name')).toHaveDisplayValue('');
    expect(screen.getByTestId('product-form-title')).toHaveTextContent('New product');
  });

  it('has a placeholder for photos that says upload is coming', () => {
    renderSeller(<VendorProductScreen />);

    press('product-image-upload');

    expect(toast()?.message).toBe('Photo upload is coming soon.');
  });
});

describe('category picker: hidden categories cascade (decided 2026-10-20)', () => {
  it('offers the live taxonomy in tree order, subcategories indented, keyed by id', () => {
    expect(OFFERED.map((option) => option.label)).toEqual([
      'Groceries',
      '— Rice, Flour & Pulses',
      '— Noodles & Snacks',
      '— Tea & Coffee',
      '— Dairy',
      '— Fresh Vegetables',
      '— Honey & Spreads',
    ]);
    expect(categoryNameOf(OFFERED, DAIRY)).toBe('Dairy');
  });

  it('never offers a category whose parent is hidden, nor anything below it', () => {
    // Organic Milk is active itself, under Dairy; the server left out Dairy, which the admin hid.
    const organic = category({
      id: catId(20),
      name: 'Organic Milk',
      slug: 'organic-milk',
      parent_id: DAIRY,
    });
    const withoutDairy = [...TAXONOMY.filter((row) => row.slug !== 'dairy'), organic];

    const offered = productCategoryOptions(withoutDairy);

    expect(offered.map((option) => option.value)).not.toContain(DAIRY);
    expect(offered.map((option) => option.value)).not.toContain(catId(20));
    expect(categoryNameOf(offered, catId(20))).toBeNull();
  });

  it('refuses a category that was hidden after the form was opened', () => {
    const withoutDairy = productCategoryOptions(TAXONOMY.filter((row) => row.slug !== 'dairy'));

    expect(validateProductForm(form({ categoryId: DAIRY }), [], withoutDairy)).toEqual({
      ok: false,
      errors: { categoryId: 'category' },
    });
  });

  it('marks the products filed under a hidden category', async () => {
    await renderCatalogue(TAXONOMY.filter((row) => row.slug !== 'dairy'));

    expect(
      within(screen.getByTestId(`product-${GHEE_ID}`)).getByText('Category hidden by Hamro Pasal'),
    ).toBeOnTheScreen();
  });

  it('makes the vendor choose another category when editing a product whose category is hidden', async () => {
    const withoutDairy = TAXONOMY.filter((row) => row.slug !== 'dairy');
    const view = await renderCatalogue(withoutDairy);
    openProduct(GHEE_ID);
    view.rerender(<VendorProductScreen />);
    press('product-category');
    expect(screen.queryByTestId(`product-category-option-${DAIRY}`)).not.toBeOnTheScreen();
    press('product-category');

    press('product-save');

    expect(screen.getByTestId('product-category-error')).toHaveTextContent('Choose a category.');
    expect(requests.some((each) => each.method === 'PUT')).toBe(false);
  });
});

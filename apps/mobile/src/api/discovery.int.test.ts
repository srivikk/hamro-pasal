import { act, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { SEARCH_DEBOUNCE_MS } from '../features/discovery/discovery-rules';
import { useCategoriesQuery } from '../features/discovery/useCategoriesQuery';
import { useProductSearch } from '../features/discovery/useProductSearch';
import { useAuthStore } from '../store/useAuthStore';
import {
  categoryList,
  errorBody,
  GROCERIES_ID,
  HONEY_ID,
  productList,
  publicProduct,
  TEA_ID,
} from '../test/api-fixtures';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../test/msw';
import { renderHookWithProviders } from '../test/render';
import {
  CATEGORIES_PATH,
  CATEGORY_NOT_FOUND,
  fetchCategories,
  fetchProducts,
  PRODUCTS_PATH,
} from './catalog';
import { CLIENT_ERROR_CODES } from './http';

setupApiTestEnvironment();

function endpoint(path: string, respond: (call: number) => Response) {
  const received: CapturedRequest[] = [];
  server.use(
    http.get(apiUrl(path), async ({ request }) => {
      received.push(await capture(request));
      return respond(received.length);
    }),
  );
  return received;
}

const queryOf = (request: CapturedRequest | undefined) =>
  Object.fromEntries(request?.url.searchParams ?? []);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /api/categories', () => {
  it('is public: no Bearer token is sent, and it works signed out', async () => {
    const received = endpoint(CATEGORIES_PATH, () => HttpResponse.json(categoryList()));
    useAuthStore.getState().clearSession();

    const body = await fetchCategories();

    expect(received).toHaveLength(1);
    expect(received[0]?.url.pathname).toBe('/api/categories');
    expect(received[0]?.headers.get('authorization')).toBeNull();
    expect(body).toEqual(categoryList());
  });

  it('rejects a taxonomy that leaks admin fields', async () => {
    endpoint(CATEGORIES_PATH, () =>
      HttpResponse.json({
        categories: [{ ...categoryList().categories[0], is_active: true, product_count: 3 }],
      }),
    );

    await expect(fetchCategories()).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });

  it('is cached: a second reader of the hook makes no second request', async () => {
    const received = endpoint(CATEGORIES_PATH, () => HttpResponse.json(categoryList()));

    const { result } = renderHookWithProviders(() => ({
      first: useCategoriesQuery(),
      second: useCategoriesQuery(),
    }));
    await waitFor(() => {
      expect(result.current.second.isSuccess).toBe(true);
    });

    expect(received).toHaveLength(1);
    expect(result.current.first.data).toEqual(categoryList());
  });
});

describe('GET /api/products', () => {
  it('sends only the filters that are set, without a token', async () => {
    const received = endpoint(PRODUCTS_PATH, () => HttpResponse.json(productList()));

    await fetchProducts({ categoryId: null, search: null });
    await fetchProducts({ categoryId: GROCERIES_ID, search: 'wai wai' }, TEA_ID);

    expect(received[0]?.headers.get('authorization')).toBeNull();
    expect(queryOf(received[0])).toEqual({});
    expect(queryOf(received[1])).toEqual({
      category_id: GROCERIES_ID,
      search: 'wai wai',
      cursor: TEA_ID,
    });
  });

  it('parses the product with its stock', async () => {
    endpoint(PRODUCTS_PATH, () =>
      HttpResponse.json(productList([publicProduct({ stock_quantity: 7 })])),
    );

    const page = await fetchProducts({ categoryId: null, search: 'tea' });

    expect(page.products[0]).toMatchObject({
      name: 'Ilam Tea 500g',
      description: 'Orthodox black tea from Ilam.',
      price_npr: 450,
      unit: 'pack',
      stock_quantity: 7,
    });
    expect(page.next_cursor).toBeNull();
  });

  it('rejects a product without a stock count (a pre-Phase-18 API)', async () => {
    const { stock_quantity: _stock, ...withoutStock } = publicProduct();
    endpoint(PRODUCTS_PATH, () =>
      HttpResponse.json({ products: [withoutStock], next_cursor: null }),
    );

    await expect(fetchProducts({ categoryId: null, search: 'tea' })).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.badResponse,
    });
  });
});

describe('useProductSearch (300 ms debounce)', () => {
  it('asks nothing while there is neither a search nor a category', async () => {
    const received = endpoint(PRODUCTS_PATH, () => HttpResponse.json(productList()));

    const { result } = renderHookWithProviders(() => useProductSearch('   ', null));
    await act(() => wait(SEARCH_DEBOUNCE_MS + 100));

    expect(received).toHaveLength(0);
    expect(result.current.active).toBe(false);
    expect(result.current.isDebouncing).toBe(false);
  });

  it('sends one request for a burst of keystrokes, with the text as it was last', async () => {
    const received = endpoint(PRODUCTS_PATH, () => HttpResponse.json(productList()));
    const { result, rerender } = renderHookWithProviders(
      ({ input }: { input: string }) => useProductSearch(input, null),
      { initialProps: { input: '' } },
    );

    for (const input of ['i', 'il', 'ila', 'ilam', 'ilam ', 'ilam t', 'ilam te', 'ilam tea']) {
      rerender({ input });
      await act(() => wait(40));
    }
    // 320 ms of typing, never 300 ms at rest: nothing was sent, and the hook says it is waiting.
    expect(received).toHaveLength(0);
    expect(result.current).toMatchObject({ active: true, isDebouncing: true });

    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });
    await act(() => wait(SEARCH_DEBOUNCE_MS + 100));

    expect(received.map(queryOf)).toEqual([{ search: 'ilam tea' }]);
    expect(result.current.isDebouncing).toBe(false);
    expect(result.current.search).toBe('ilam tea');
  });

  it('does not ask again when only the whitespace around the text changes', async () => {
    const received = endpoint(PRODUCTS_PATH, () => HttpResponse.json(productList()));
    const { result, rerender } = renderHookWithProviders(
      ({ input }: { input: string }) => useProductSearch(input, null),
      { initialProps: { input: 'tea' } },
    );
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });

    rerender({ input: 'tea ' });
    await act(() => wait(SEARCH_DEBOUNCE_MS + 100));

    expect(received).toHaveLength(1);
    expect(result.current.isDebouncing).toBe(false);
  });

  it('asks for a category at once (a tap is not debounced), combined with the search', async () => {
    const received = endpoint(PRODUCTS_PATH, () => HttpResponse.json(productList()));
    const { result, rerender } = renderHookWithProviders(
      ({ categoryId }: { categoryId: string | null }) => useProductSearch('tea', categoryId),
      { initialProps: { categoryId: null as string | null } },
    );
    await waitFor(() => {
      expect(received).toHaveLength(1);
    });

    rerender({ categoryId: GROCERIES_ID });
    await waitFor(() => {
      expect(received).toHaveLength(2);
    });
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
    });

    expect(received.map(queryOf)).toEqual([
      { search: 'tea' },
      { category_id: GROCERIES_ID, search: 'tea' },
    ]);
  });

  it('pages with the cursor the server returned', async () => {
    const received = endpoint(PRODUCTS_PATH, (call) =>
      call === 1
        ? HttpResponse.json(productList([publicProduct()], TEA_ID))
        : HttpResponse.json(productList([publicProduct({ id: HONEY_ID, name: 'Local Honey' })])),
    );
    const { result } = renderHookWithProviders(() => useProductSearch('', GROCERIES_ID));
    await waitFor(() => {
      expect(result.current.query.hasNextPage).toBe(true);
    });

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => {
      expect(
        result.current.query.data?.pages.flatMap((page) => page.products.map((p) => p.id)),
      ).toEqual([TEA_ID, HONEY_ID]);
    });
    expect(queryOf(received[1])).toEqual({ category_id: GROCERIES_ID, cursor: TEA_ID });
    expect(result.current.query.hasNextPage).toBe(false);
  });

  it('refreshes the category pills when the chosen category is gone (404), without retrying', async () => {
    const products = endpoint(PRODUCTS_PATH, () =>
      HttpResponse.json(errorBody(CATEGORY_NOT_FOUND), { status: 404 }),
    );
    const categories = endpoint(CATEGORIES_PATH, () => HttpResponse.json(categoryList()));

    const { result } = renderHookWithProviders(() => ({
      categories: useCategoriesQuery(),
      search: useProductSearch('', GROCERIES_ID),
    }));
    await waitFor(() => {
      expect(result.current.search.query.isError).toBe(true);
    });
    await waitFor(() => {
      expect(categories).toHaveLength(2);
    });

    expect(products).toHaveLength(1);
  });
});

import { fireEvent, screen, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorMenuScreen from '../../../app/vendor/[id]';
import { VENDOR_NOT_FOUND, vendorProductsPath } from '../../api/catalog';
import { ReplaceCartModal } from '../../components/ReplaceCartModal';
import { useAddressStore } from '../../store/useAddressStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  checkoutResponse,
  errorBody,
  MUSTARD_OIL_ID,
  NOODLES,
  PATAN_VENDOR,
  RICE,
  THAMEL_ADDRESS,
  THAMEL_VENDOR,
  vendorMenu,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';

const THAMEL = THAMEL_VENDOR.id;
const BOUDHA = '6f1c2a10-0000-4000-8000-000000000014';

let mockVendorId = THAMEL;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockVendorId }),
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

setupApiTestEnvironment();

/** Serves GET /api/vendors/:id/products for one vendor and records the query strings. */
function serveMenu(vendorId: string, respond: () => Response) {
  const queries: Record<string, string>[] = [];
  server.use(
    http.get(apiUrl(vendorProductsPath(vendorId)), ({ request }) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams));
      return respond();
    }),
  );
  return queries;
}

function renderMenu(vendorId: string) {
  mockVendorId = vendorId;
  return renderWithProviders(
    <>
      <VendorMenuScreen />
      <ReplaceCartModal />
    </>,
  );
}

beforeEach(() => {
  serveMenu(THAMEL, () => HttpResponse.json(vendorMenu()));
});

describe('Vendor menu screen (GET /api/vendors/:id/products)', () => {
  it('lists the vendor products with localized prices and stock', async () => {
    renderMenu(THAMEL);

    expect(await screen.findByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(screen.getByText('Rs. 1150')).toBeOnTheScreen();
    const oil = screen.getByTestId(`menu-product-${MUSTARD_OIL_ID}`);
    expect(within(oil).getByText('Out of stock')).toBeOnTheScreen();
    expect(within(oil).queryByRole('button')).toBeNull();
  });

  it("asks for the menu from the saved address's pin", async () => {
    const queries = serveMenu(THAMEL, () => HttpResponse.json(vendorMenu()));
    useAddressStore
      .getState()
      .setAddress({ ...THAMEL_ADDRESS, exact_lat: 27.712, exact_lng: 85.31 });
    renderMenu(THAMEL);

    expect(await screen.findByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(queries[0]).toEqual({
      lat: '27.712',
      lng: '85.31',
      municipality_palika_string: 'Kathmandu Metropolitan City',
    });
  });

  it('refuses to add past the stock the cart line already knows (Phase 18)', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 1 }, 1);
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));

    expect(screen.getByTestId('menu-banner')).toHaveTextContent(
      'No more of this item is in stock.',
    );
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 1, availableStock: 1 });
  });

  it('adds a product with the vendor snapshot the cart summary needs', async () => {
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));
    fireEvent.press(screen.getByRole('button', { name: 'Add Basmati Rice 5kg' }));

    expect(useCartStore.getState().vendor).toEqual({
      id: THAMEL,
      name: 'Thamel Kirana Pasal',
      deliveryFeeNpr: 50,
      minOrderValueNpr: 500,
    });
    expect(useCartStore.getState().lines).toEqual([
      {
        productId: RICE.id,
        name: 'Basmati Rice 5kg',
        unitPriceNpr: 1150,
        quantity: 2,
        availableStock: null,
      },
    ]);
    expect(screen.getByText('2 in cart')).toBeOnTheScreen();
  });

  it('opens the replace-cart modal when the cart holds another vendor', async () => {
    useCartStore.getState().addItem(
      { id: BOUDHA, name: 'Boudha Fresh Mart', deliveryFeeNpr: 60, minOrderValueNpr: 300 },
      {
        id: '7a2b3c40-0014-4000-8000-000000000001',
        name: 'Fresh Tomatoes 1kg',
        unitPriceNpr: 90,
      },
    );
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: `Add ${NOODLES.name}` }));

    expect(
      screen.getByText(
        'Your cart has items from Boudha Fresh Mart. Adding items from Thamel Kirana Pasal will clear it.',
      ),
    ).toBeOnTheScreen();
    expect(useCartStore.getState().vendor?.id).toBe(BOUDHA);

    fireEvent.press(screen.getByRole('button', { name: 'Clear and add' }));

    expect(useCartStore.getState().vendor?.id).toBe(THAMEL);
    expect(useCartStore.getState().lines.map((line) => line.name)).toEqual([NOODLES.name]);
  });

  it('shows an Explore Further vendor for browsing only, with carts disabled', async () => {
    serveMenu(PATAN_VENDOR.id, () =>
      HttpResponse.json(
        vendorMenu({
          vendor: PATAN_VENDOR,
          serviceable: false,
          products: [
            {
              id: '7a2b3c40-0012-4000-8000-000000000002',
              name: 'Local Honey 500g',
              price_npr: 900,
              in_stock: true,
            },
          ],
        }),
      ),
    );
    renderMenu(PATAN_VENDOR.id);

    expect(
      await screen.findByText(
        "This shop doesn't deliver to your location. You can browse, but not order.",
      ),
    ).toBeOnTheScreen();
    const add = screen.getByRole('button', { name: 'Add Local Honey 500g' });
    expect(add).toBeDisabled();

    fireEvent.press(add);
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it('blocks additions while a reservation is waiting for payment', async () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    renderMenu(THAMEL);

    expect(
      await screen.findByText('Finish your current checkout before adding more items.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: `Add ${NOODLES.name}` })).toBeDisabled();
  });

  it('reports a vendor the server does not list (404 VENDOR_NOT_FOUND), with no retry', async () => {
    const hidden = '6f1c2a10-0000-4000-8000-000000000013';
    serveMenu(hidden, () => HttpResponse.json(errorBody(VENDOR_NOT_FOUND), { status: 404 }));
    renderMenu(hidden);

    expect(await screen.findByText("This shop isn't available.")).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers a retry for other failures', async () => {
    serveMenu(THAMEL, () => HttpResponse.json(errorBody('UNAUTHENTICATED'), { status: 401 }));
    renderMenu(THAMEL);

    expect(
      await screen.findByText("Couldn't load this shop's products. Check your connection."),
    ).toBeOnTheScreen();
    serveMenu(THAMEL, () => HttpResponse.json(vendorMenu()));
    fireEvent.press(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Basmati Rice 5kg')).toBeOnTheScreen();
  });
});

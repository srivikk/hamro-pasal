import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorMenuScreen from '../../../app/(tabs)/(home)/vendor/[id]';
import { VENDOR_NOT_FOUND, vendorProductsPath } from '../../api/catalog';
import { ReplaceCartModal } from '../../components/ReplaceCartModal';
import { useAddressStore } from '../../store/useAddressStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import {
  checkoutResponse,
  errorBody,
  menuProduct,
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
  useToastStore.setState({ toast: null });
  serveMenu(THAMEL, () => HttpResponse.json(vendorMenu()));
});

describe('Vendor menu screen (GET /api/vendors/:id/products)', () => {
  it('lists the vendor products with localized prices and stock', async () => {
    renderMenu(THAMEL);

    expect(await screen.findByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(screen.getByText('Rs. 1150')).toBeOnTheScreen();
    const oil = screen.getByTestId(`menu-product-${MUSTARD_OIL_ID}`);
    expect(within(oil).getByText('OUT OF STOCK')).toBeOnTheScreen();
    // No Add button at all; the row can still be opened for its details.
    expect(within(oil).queryByRole('button', { name: 'Add Mustard Oil 1L' })).toBeNull();
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

  it("caps a line added from the menu at the menu's own stock_quantity (Phase 19)", async () => {
    serveMenu(THAMEL, () =>
      HttpResponse.json(
        vendorMenu({ products: [menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 2)] }),
      ),
    );
    renderMenu(THAMEL);
    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));
    // "Add" is now the - 1 + control: more are added with its plus.
    const more = screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' });

    fireEvent.press(more);
    expect(useToastStore.getState().toast).toBeNull();
    fireEvent.press(more);

    expect(useToastStore.getState().toast).toMatchObject({ message: 'Maximum stock reached' });
    expect(useCartStore.getState().lines).toEqual([
      {
        productId: RICE.id,
        name: 'Basmati Rice 5kg',
        unitPriceNpr: 1150,
        quantity: 2,
        availableStock: 2,
      },
    ]);
  });

  it('a menu-added line cannot be raised past the stock in the cart either', async () => {
    serveMenu(THAMEL, () =>
      HttpResponse.json(
        vendorMenu({ products: [menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 3)] }),
      ),
    );
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));
    act(() => {
      useCartStore.getState().setQuantity(RICE.id, 9);
    });

    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 3, availableStock: 3 });
  });

  it('the menu refreshes what a cart line knows: a restocked product can be added again', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 1 }, 1);
    renderMenu(THAMEL);

    // The cart already holds one, so the row shows the stepper, not "Add".
    fireEvent.press(await screen.findByRole('button', { name: 'Add one Basmati Rice 5kg' }));

    expect(screen.queryByTestId('menu-banner')).toBeNull();
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 2, availableStock: 12 });
  });

  it('treats a product as sold out by its stock_quantity, not by the flag alone', async () => {
    serveMenu(THAMEL, () =>
      HttpResponse.json(
        vendorMenu({
          products: [
            { id: RICE.id, name: RICE.name, price_npr: 1150, in_stock: true, stock_quantity: 0 },
          ],
        }),
      ),
    );
    renderMenu(THAMEL);

    const rice = await screen.findByTestId(`menu-product-${RICE.id}`);
    expect(within(rice).getByText('OUT OF STOCK')).toBeOnTheScreen();
    expect(within(rice).queryByRole('button', { name: 'Add Basmati Rice 5kg' })).toBeNull();
  });

  it('adds a product with the vendor snapshot the cart summary needs', async () => {
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));
    fireEvent.press(screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' }));

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
        availableStock: 12,
      },
    ]);
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('2');
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
        'Your cart contains items from Boudha Fresh Mart. Do you want to discard them to start a new order with Thamel Kirana Pasal?',
      ),
    ).toBeOnTheScreen();
    // Blocked: nothing was added, the first shop's cart is intact.
    expect(useCartStore.getState().vendor?.id).toBe(BOUDHA);
    expect(useCartStore.getState().lines.map((line) => line.name)).toEqual(['Fresh Tomatoes 1kg']);

    fireEvent.press(screen.getByRole('button', { name: 'Clear Cart' }));

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
              stock_quantity: 14,
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

  it('lets a guest open a menu and add to the cart without signing in', async () => {
    useAuthStore.getState().clearSession();
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));

    expect(useCartStore.getState().vendor?.id).toBe(THAMEL);
    expect(useCartStore.getState().lines).toMatchObject([{ quantity: 1 }]);
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

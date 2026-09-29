import { fireEvent, screen, within } from '@testing-library/react-native';

import VendorMenuScreen from '../../../app/vendor/[id]';
import { ReplaceCartModal } from '../../components/ReplaceCartModal';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { checkoutResponse } from '../../test/api-fixtures';
import { renderWithProviders } from '../../test/render';
import type * as MockMenuApi from './mock-menu-api';
import { MOCK_PRODUCTS_BY_VENDOR } from './mock-menu-api';

const THAMEL = '6f1c2a10-0000-4000-8000-000000000011';
const BOUDHA = '6f1c2a10-0000-4000-8000-000000000014';
const PATAN = '6f1c2a10-0000-4000-8000-000000000012';

let mockVendorId = THAMEL;
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: mockVendorId }),
  Stack: { Screen: () => null },
  router: { push: jest.fn() },
}));

jest.mock('./mock-menu-api', () => {
  const actual = jest.requireActual<typeof MockMenuApi>('./mock-menu-api');
  return {
    ...actual,
    fetchMockVendorMenu: (...[vendorId, customer]: Parameters<typeof actual.fetchMockVendorMenu>) =>
      actual.fetchMockVendorMenu(vendorId, customer, { latencyMs: 0 }),
  };
});

const productId = (vendorId: string, index: number): string => {
  const product = MOCK_PRODUCTS_BY_VENDOR[vendorId]?.[index];
  if (product === undefined) throw new Error('fixture');
  return product.id;
};

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
  useCartStore.getState().clearCart();
  useCheckoutStore.setState({
    session: null,
    attempt: null,
    deliveryOtp: null,
    sessionExpired: false,
  });
});

describe('Vendor menu screen', () => {
  it('lists the vendor products with localized prices and stock', async () => {
    renderMenu(THAMEL);

    expect(await screen.findByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(screen.getByText('Rs. 1150')).toBeOnTheScreen();
    const oil = screen.getByTestId(`menu-product-${productId(THAMEL, 3)}`);
    expect(within(oil).getByText('Out of stock')).toBeOnTheScreen();
    expect(within(oil).queryByRole('button')).toBeNull();
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
        productId: productId(THAMEL, 1),
        name: 'Basmati Rice 5kg',
        unitPriceNpr: 1150,
        quantity: 2,
      },
    ]);
    expect(screen.getByText('2 in cart')).toBeOnTheScreen();
  });

  it('opens the replace-cart modal when the cart holds another vendor', async () => {
    useCartStore
      .getState()
      .addItem(
        { id: BOUDHA, name: 'Boudha Fresh Mart', deliveryFeeNpr: 60, minOrderValueNpr: 300 },
        { id: productId(BOUDHA, 0), name: 'Fresh Tomatoes 1kg', unitPriceNpr: 90 },
      );
    renderMenu(THAMEL);

    fireEvent.press(await screen.findByRole('button', { name: 'Add Ilam Tea 500g' }));

    expect(
      screen.getByText(
        'Your cart has items from Boudha Fresh Mart. Adding items from Thamel Kirana Pasal will clear it.',
      ),
    ).toBeOnTheScreen();
    expect(useCartStore.getState().vendor?.id).toBe(BOUDHA);

    fireEvent.press(screen.getByRole('button', { name: 'Clear and add' }));

    expect(useCartStore.getState().vendor?.id).toBe(THAMEL);
    expect(useCartStore.getState().lines.map((line) => line.name)).toEqual(['Ilam Tea 500g']);
  });

  it('shows an Explore Further vendor for browsing only, with carts disabled', async () => {
    renderMenu(PATAN);

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
    expect(screen.getByRole('button', { name: 'Add Ilam Tea 500g' })).toBeDisabled();
  });

  it('reports a vendor that is not listed', async () => {
    renderMenu('6f1c2a10-0000-4000-8000-000000000013');

    expect(await screen.findByText("This shop isn't available.")).toBeOnTheScreen();
  });
});

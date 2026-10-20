import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';

import VendorMenuScreen from '../../../app/(tabs)/(home)/vendor/[id]';
import { PRODUCTS_PATH, vendorProductsPath } from '../../api/catalog';
import { ReplaceCartModal } from '../../components/ReplaceCartModal';
import { useCartStore } from '../../store/useCartStore';
import { useCheckoutStore } from '../../store/useCheckoutStore';
import { useFavouritesStore } from '../../store/useFavouritesStore';
import { useToastStore } from '../../store/useToastStore';
import {
  checkoutResponse,
  feedResponse,
  GROCERIES_ID,
  menuProduct,
  MUSTARD_OIL_ID,
  NOODLES,
  productList,
  publicProduct,
  RICE,
  THAMEL_ADDRESS,
  THAMEL_VENDOR,
  vendorMenu,
} from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { createTestQueryClient, renderWithProviders } from '../../test/render';
import { feedQueryKey } from '../feed/useFeedQuery';
import { customerLocationFrom } from '../location/customer-location';
import { vendorExtras } from '../promo/mock-promotions';
import { NO_VENDOR_EXTRAS, type VendorExtras } from '../promo/promo-model';
import { fetchMenuCatalog, searchMenu } from './menu-sections';
import { ProductDetailSheet } from './ProductDetailSheet';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: '6f1c2a10-0000-4000-8000-000000000011' }),
  Stack: { Screen: () => null },
}));
jest.mock('../promo/mock-promotions', () => ({
  PROMO_MOCKS_ENABLED: true,
  vendorExtras: jest.fn(),
}));

setupApiTestEnvironment();

const EXTRAS: VendorExtras = {
  cover_image_url: 'https://cdn.test/thamel.jpg',
  rating_average: 4.3,
  rating_count: 237,
  locality: 'Thamel',
  prep_minutes: 20,
  average_cost_npr: 500,
  top_offer: '20% OFF up to Rs. 100',
  offer_tags: ['20% OFF up to Rs. 100'],
  is_sponsored: false,
};
const RICE_PHOTO = 'https://cdn.test/rice.jpg';

/** The menu (three products) and, from the public list, what the menu does not carry. */
function serveShop(menu = vendorMenu()) {
  server.use(
    http.get(apiUrl(vendorProductsPath(THAMEL_VENDOR.id)), () => HttpResponse.json(menu)),
    http.get(apiUrl(PRODUCTS_PATH), () =>
      HttpResponse.json(
        productList([
          publicProduct({
            id: RICE.id,
            name: RICE.name,
            category_id: GROCERIES_ID,
            description: 'Long-grain aged basmati.',
            unit: 'bag',
            image_urls: [RICE_PHOTO, 'https://cdn.test/rice-2.jpg'],
          }),
          publicProduct({
            id: NOODLES.id,
            name: NOODLES.name,
            category_id: GROCERIES_ID,
            description: null,
            unit: 'carton',
          }),
        ]),
      ),
    ),
  );
}

function renderShop(queryClient = createTestQueryClient()) {
  return renderWithProviders(
    <>
      <VendorMenuScreen />
      <ReplaceCartModal />
    </>,
    { queryClient },
  );
}

/** Opens the detail sheet of a product once the shop's catalogue (descriptions) has arrived. */
async function openProduct(productId: string) {
  fireEvent.press(await screen.findByTestId(`menu-product-open-${productId}`));
  return within(screen.getByTestId('product-sheet'));
}

beforeEach(() => {
  useToastStore.setState({ toast: null });
  jest.clearAllMocks();
  jest.mocked(vendorExtras).mockReturnValue(EXTRAS);
  serveShop();
});

describe('Shop page header', () => {
  it('shows the name, rating and best offer on the card over the banner', async () => {
    renderShop();

    const shop = within(await screen.findByTestId('shop-card'));
    expect(shop.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(shop.getByTestId('shop-rating')).toHaveTextContent('4.3');
    // 237 ratings are shown rounded down, with a plus.
    expect(shop.getByTestId('shop-rating-count')).toHaveTextContent('(200+)');
    // The neighbourhood from the shop's extras, then the Palika from the menu response.
    expect(shop.getByTestId('shop-location')).toHaveTextContent(
      'Thamel, Kathmandu Metropolitan City',
    );
    // The offer is its own pill under the card, not a line inside it.
    expect(shop.queryByText('20% OFF up to Rs. 100')).toBeNull();
    const offer = screen.getByTestId('shop-offer');
    expect(within(offer).getByText('20% OFF up to Rs. 100')).toBeOnTheScreen();
    expect(screen.getByLabelText('Offer: 20% OFF up to Rs. 100')).toBeOnTheScreen();
    expect(screen.getByTestId('shop-banner')).toBeOnTheScreen();
    expect(screen.getByLabelText('Search in this shop')).toBeOnTheScreen();
  });

  it('takes the distance (and so the delivery time) from the feed the customer came from', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(
      feedQueryKey(customerLocationFrom(THAMEL_ADDRESS)),
      feedResponse({
        serviceable: [{ vendor: vendorMenu().vendor, distance_km: 2.04, serviceable: true }],
      }),
    );
    renderShop(queryClient);

    expect(await screen.findByTestId('shop-distance')).toHaveTextContent('2 km away');
    // 20 min to prepare + 7 min for 2.04 km, rounded up to 30.
    expect(screen.getByTestId('shop-eta')).toHaveTextContent('30–40 mins');
  });

  it('shows no distance for a page opened without the feed, and asks for none', async () => {
    renderShop();
    await screen.findByTestId('shop-card');

    expect(screen.queryByTestId('shop-distance')).toBeNull();
    expect(screen.queryByTestId('shop-eta')).toBeNull();
  });

  it('says a closed or paused shop takes no order, and blocks Add (step 7.3)', async () => {
    serveShop({ ...vendorMenu(), open_now: false, closed_reason: 'HOURS' });
    const view = renderShop();
    expect(await screen.findByTestId('menu-banner')).toHaveTextContent(
      // Step 7.4: followed by its Notify Me button.
      /^This shop is closed right now. You can browse, but not order./,
    );
    view.unmount();

    serveShop({ ...vendorMenu(), open_now: false, closed_reason: 'AUTO_PAUSED' });
    renderShop();
    expect(await screen.findByTestId('menu-banner')).toHaveTextContent(
      /^This shop is paused right now. You can browse, but not order./,
    );
  });

  it('shows the shop’s free-delivery threshold, and nothing when it has none (step 7.2)', async () => {
    const menu = vendorMenu();
    serveShop({ ...menu, vendor: { ...menu.vendor, free_delivery_above_npr: 1000 } });
    const view = renderShop();

    expect(await screen.findByTestId('shop-free-delivery')).toHaveTextContent(
      'Free delivery on orders over Rs. 1000',
    );

    view.unmount();
    serveShop();
    renderShop();
    await screen.findByTestId('shop-card');
    expect(screen.queryByTestId('shop-free-delivery')).toBeNull();
  });

  it('is a plain card when the shop has no rating, offer or banner', async () => {
    jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
    renderShop();

    const shop = within(await screen.findByTestId('shop-card'));
    expect(shop.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(screen.queryByTestId('shop-rating')).toBeNull();
    expect(screen.queryByTestId('shop-rating-count')).toBeNull();
    expect(screen.queryByTestId('shop-offer')).toBeNull();
    // Without a known neighbourhood the Palika alone is the location.
    expect(shop.getByTestId('shop-location')).toHaveTextContent('Kathmandu Metropolitan City');
  });

  it('goes back from the button on the banner', async () => {
    renderShop();

    fireEvent.press(await screen.findByRole('button', { name: 'Back' }));

    expect(jest.mocked(router.back)).toHaveBeenCalledTimes(1);
  });

  it('keeps the delivery notice under the header', async () => {
    serveShop(vendorMenu({ serviceable: false }));
    renderShop();

    expect(await screen.findByTestId('menu-banner')).toHaveTextContent(
      "This shop doesn't deliver to your location. You can browse, but not order.",
    );
    expect(screen.queryByTestId('shop-eta')).toBeNull();
  });
});

describe('Shop page search', () => {
  it('keeps only the items whose name has every word typed', async () => {
    renderShop();
    await screen.findByTestId(`menu-product-${RICE.id}`);

    fireEvent.changeText(screen.getByTestId('menu-search'), '  RICE basmati ');

    expect(screen.getByTestId(`menu-product-${RICE.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`menu-product-${NOODLES.id}`)).toBeNull();
    expect(screen.queryByTestId(`menu-product-${MUSTARD_OIL_ID}`)).toBeNull();

    fireEvent.changeText(screen.getByTestId('menu-search'), '');
    expect(screen.getByTestId(`menu-product-${NOODLES.id}`)).toBeOnTheScreen();
  });

  it('says so when nothing matches, and hides the ITEMS button', async () => {
    renderShop();
    await screen.findByTestId(`menu-product-${RICE.id}`);

    fireEvent.changeText(screen.getByTestId('menu-search'), 'momo');

    expect(screen.getByTestId('menu-empty')).toHaveTextContent('No items match "momo".');
    expect(screen.queryByTestId('menu-fab')).toBeNull();
    // The header, with the field being typed in, stays.
    expect(screen.getByTestId('menu-search').props.value).toBe('momo');
  });

  it('only announces voice search for now', async () => {
    renderShop();

    fireEvent.press(await screen.findByTestId('menu-voice-search'));

    expect(useToastStore.getState().toast).toMatchObject({
      message: 'Voice search is coming soon.',
    });
  });

  it('matches words anywhere in the name, case-insensitively', () => {
    const menu = vendorMenu().products;

    expect(searchMenu(menu, 'oil').map((product) => product.id)).toEqual([MUSTARD_OIL_ID]);
    expect(searchMenu(menu, '5KG rice').map((product) => product.id)).toEqual([RICE.id]);
    expect(searchMenu(menu, '   ')).toEqual(menu);
    expect(searchMenu(menu, 'rice oil')).toEqual([]);
  });
});

describe('Item detail sheet', () => {
  it('opens for the tapped product without adding anything to the cart', async () => {
    renderShop();
    const sheet = await openProduct(RICE.id);
    // The description comes with the shop's catalogue, a moment after the menu.
    await sheet.findByTestId('product-sheet-description');

    expect(useCartStore.getState().lines).toEqual([]);
    expect(sheet.getByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(sheet.getByTestId('product-sheet-price')).toHaveTextContent('Rs. 1150 / bag');
    expect(sheet.getByTestId('product-sheet-description')).toHaveTextContent(
      'Long-grain aged basmati.',
    );
    expect(sheet.getByTestId('product-sheet-image').props.source).toEqual({ uri: RICE_PHOTO });
    expect(sheet.getByText('12 in stock')).toBeOnTheScreen();
    // SPEC has no product ratings: no pill.
    expect(sheet.queryByTestId('product-sheet-rating')).toBeNull();
  });

  it('adds the chosen quantity with ADD, then closes', async () => {
    renderShop();
    const sheet = await openProduct(RICE.id);
    // The description comes with the shop's catalogue, a moment after the menu.
    await sheet.findByTestId('product-sheet-description');

    fireEvent.press(sheet.getByRole('button', { name: 'Increase quantity of Basmati Rice 5kg' }));
    fireEvent.press(sheet.getByRole('button', { name: 'Increase quantity of Basmati Rice 5kg' }));
    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('3');
    expect(sheet.getByTestId('product-sheet-add')).toHaveTextContent('ADD · Rs. 3450');
    fireEvent.press(sheet.getByRole('button', { name: 'Decrease quantity of Basmati Rice 5kg' }));
    fireEvent.press(sheet.getByRole('button', { name: 'Add Basmati Rice 5kg to cart' }));

    expect(useCartStore.getState().vendor).toEqual({
      id: THAMEL_VENDOR.id,
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
    await waitFor(() => {
      expect(screen.queryByTestId('product-sheet')).toBeNull();
    });
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('2');
  });

  it('opens on the quantity the cart holds and changes the cart line itself', async () => {
    serveShop(vendorMenu({ products: [menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 5)] }));
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 5 }, 3);
    renderShop();
    const sheet = await openProduct(RICE.id);

    // Not back at 1: the cart's own 3, with nothing to "add" (it is already in the cart).
    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('3');
    expect(sheet.queryByTestId('product-sheet-add')).toBeNull();
    expect(sheet.getByTestId('product-sheet-done')).toHaveTextContent('DONE · Rs. 3450');

    fireEvent.press(sheet.getByTestId('product-sheet-increase'));
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 4 });
    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('4');
    // The menu row behind the sheet shows the same line.
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('4');

    fireEvent.press(sheet.getByTestId('product-sheet-decrease'));
    fireEvent.press(sheet.getByTestId('product-sheet-decrease'));
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 2 });
    expect(sheet.getByTestId('product-sheet-done')).toHaveTextContent('DONE · Rs. 2300');

    fireEvent.press(sheet.getByTestId('product-sheet-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('product-sheet')).toBeNull();
    });
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 2 });
  });

  it('stops at the stock and says "Maximum stock reached" when plus is pressed there', async () => {
    serveShop(vendorMenu({ products: [menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 3)] }));
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 3 }, 2);
    renderShop();
    const sheet = await openProduct(RICE.id);
    const more = sheet.getByTestId('product-sheet-increase');

    fireEvent.press(more);
    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('3');
    expect(useToastStore.getState().toast).toBeNull();

    // At the last unit the button still answers a press, with the reason.
    expect(more).not.toBeDisabled();
    fireEvent.press(more);

    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('3');
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 3 });
    expect(useToastStore.getState().toast).toMatchObject({ message: 'Maximum stock reached' });
  });

  it('says the same before the product is in the cart, and adds no more than the stock', async () => {
    serveShop(vendorMenu({ products: [menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 2)] }));
    renderShop();
    const sheet = await openProduct(RICE.id);
    const more = sheet.getByTestId('product-sheet-increase');

    fireEvent.press(more);
    fireEvent.press(more);

    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('2');
    expect(useToastStore.getState().toast).toMatchObject({ message: 'Maximum stock reached' });
    fireEvent.press(sheet.getByTestId('product-sheet-add'));
    expect(useCartStore.getState().lines[0]).toMatchObject({ quantity: 2 });
  });

  it('offers ADD again, from one, once the last unit is taken out in the sheet', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 20 }, 1);
    renderShop();
    const sheet = await openProduct(RICE.id);

    fireEvent.press(sheet.getByTestId('product-sheet-decrease'));

    expect(useCartStore.getState().lines).toEqual([]);
    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('1');
    expect(sheet.getByTestId('product-sheet-add')).toHaveTextContent('ADD · Rs. 1150');
  });

  it('starts again at one for the next product', async () => {
    renderShop();
    let sheet = await openProduct(RICE.id);
    fireEvent.press(sheet.getByRole('button', { name: 'Increase quantity of Basmati Rice 5kg' }));
    fireEvent.press(screen.getByTestId('product-sheet-backdrop'));
    await waitFor(() => {
      expect(screen.queryByTestId('product-sheet')).toBeNull();
    });
    expect(useCartStore.getState().lines).toEqual([]);

    sheet = await openProduct(NOODLES.id);

    expect(sheet.getByTestId('product-sheet-quantity')).toHaveTextContent('1');
    expect(sheet.getByText(NOODLES.name)).toBeOnTheScreen();
  });

  it('shows a sold-out product with nothing to add', async () => {
    renderShop();
    const sheet = await openProduct(MUSTARD_OIL_ID);

    expect(sheet.getByText('Out of Stock')).toBeOnTheScreen();
    // No ADD button and no quantity control at all, and the veil over the picture.
    expect(sheet.queryByTestId('product-sheet-add')).toBeNull();
    expect(sheet.queryByTestId('product-sheet-quantity')).toBeNull();
    expect(
      within(sheet.getByTestId('out-of-stock-overlay')).getByText('OUT OF STOCK'),
    ).toBeTruthy();
    expect(sheet.getByTestId('product-sheet-placeholder')).toBeOnTheScreen();
    // Not in the public list here: no description or photo, and the price without a unit.
    expect(sheet.getByTestId('product-sheet-price')).toHaveTextContent('Rs. 320');
    expect(sheet.queryByTestId('product-sheet-description')).toBeNull();
    expect(sheet.queryByTestId('product-sheet-image')).toBeNull();
  });

  it('is browse-only for a shop that does not deliver here', async () => {
    serveShop(vendorMenu({ serviceable: false }));
    renderShop();
    const sheet = await openProduct(RICE.id);

    expect(sheet.getByTestId('product-sheet-hint')).toHaveTextContent(
      "This shop doesn't deliver to your location. You can browse, but not order.",
    );
    fireEvent.press(sheet.getByTestId('product-sheet-add'));
    expect(useCartStore.getState().lines).toEqual([]);
  });

  it('adds nothing while a checkout is waiting for payment', async () => {
    useCheckoutStore.getState().startSession(checkoutResponse());
    renderShop();
    const sheet = await openProduct(RICE.id);

    expect(sheet.getByTestId('product-sheet-hint')).toHaveTextContent(
      'Finish your current checkout before adding more items.',
    );
    expect(sheet.getByTestId('product-sheet-add')).toBeDisabled();
  });

  it("closes and asks to replace the cart when it holds another shop's items", async () => {
    useCartStore.getState().addItem(
      {
        id: '6f1c2a10-0000-4000-8000-000000000014',
        name: 'Boudha Fresh Mart',
        deliveryFeeNpr: 60,
        minOrderValueNpr: 300,
      },
      { id: '7a2b3c40-0014-4000-8000-000000000001', name: 'Fresh Tomatoes 1kg', unitPriceNpr: 90 },
    );
    renderShop();
    const sheet = await openProduct(RICE.id);
    fireEvent.press(sheet.getByRole('button', { name: 'Increase quantity of Basmati Rice 5kg' }));

    fireEvent.press(sheet.getByTestId('product-sheet-add'));

    await waitFor(() => {
      expect(screen.queryByTestId('product-sheet')).toBeNull();
    });
    expect(useCartStore.getState().lines.map((line) => line.name)).toEqual(['Fresh Tomatoes 1kg']);
    fireEvent.press(screen.getByRole('button', { name: 'Clear Cart' }));
    expect(useCartStore.getState().lines).toMatchObject([{ productId: RICE.id, quantity: 2 }]);
  });

  it('still adds one straight from the row with the Add button', async () => {
    renderShop();

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));

    expect(screen.queryByTestId('product-sheet')).toBeNull();
    expect(useCartStore.getState().lines).toMatchObject([{ productId: RICE.id, quantity: 1 }]);
  });

  it('shows a rating pill only when the product has a rating', () => {
    const product = menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 5);
    const props = {
      product,
      detail: undefined,
      cartVendor: THAMEL_VENDOR,
      blockedReason: null,
      onClose: jest.fn(),
    };
    const { rerender } = renderWithProviders(<ProductDetailSheet {...props} rating={4.7} />);

    expect(screen.getByTestId('product-sheet-rating')).toHaveTextContent('4.7');

    rerender(<ProductDetailSheet {...props} rating={null} />);
    expect(screen.queryByTestId('product-sheet-rating')).toBeNull();

    rerender(<ProductDetailSheet {...props} product={null} rating={null} />);
    expect(screen.queryByTestId('product-sheet')).toBeNull();
  });
});

describe('fetchMenuCatalog', () => {
  it('reads each product’s category, description, unit and first photo in one scan', async () => {
    const catalog = await fetchMenuCatalog(THAMEL_VENDOR.id);

    expect(catalog.categoryOf).toEqual({ [RICE.id]: GROCERIES_ID, [NOODLES.id]: GROCERIES_ID });
    expect(catalog.detailOf).toEqual({
      [RICE.id]: {
        description: 'Long-grain aged basmati.',
        unit: 'bag',
        imageUrl: RICE_PHOTO,
        imageUrls: [RICE_PHOTO, 'https://cdn.test/rice-2.jpg'],
      },
      [NOODLES.id]: { description: null, unit: 'carton', imageUrl: null, imageUrls: [] },
    });
  });
});

describe('Shop header: rating count', () => {
  it.each([
    [1, '(1)'],
    [8, '(8)'],
    [95, '(90+)'],
    [320, '(300+)'],
    [1250, '(1000+)'],
  ])('shows %i ratings as %s', async (count, label) => {
    jest.mocked(vendorExtras).mockReturnValue({ ...EXTRAS, rating_count: count });
    renderShop();

    expect(await screen.findByTestId('shop-rating-count')).toHaveTextContent(label);
  });

  it('shows the pill alone when the count is unknown', async () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...EXTRAS, rating_count: null });
    renderShop();

    expect(await screen.findByTestId('shop-rating')).toBeOnTheScreen();
    expect(screen.queryByTestId('shop-rating-count')).toBeNull();
  });
});

describe('Menu row: inline quantity control', () => {
  const stepper = () => within(screen.getByTestId(`menu-stepper-${RICE.id}`));

  it('turns "Add" into - 1 + the moment it is pressed', async () => {
    renderShop();

    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));

    expect(screen.queryByRole('button', { name: 'Add Basmati Rice 5kg' })).toBeNull();
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('1');
    expect(stepper().getByRole('button', { name: 'Add one Basmati Rice 5kg' })).toBeOnTheScreen();
    expect(stepper().getByRole('button', { name: 'Remove one Basmati Rice 5kg' })).toBeTruthy();
    // Neither the detail sheet nor the cart was needed.
    expect(screen.queryByTestId('product-sheet')).toBeNull();
    expect(useCartStore.getState().lines).toMatchObject([{ productId: RICE.id, quantity: 1 }]);
  });

  it('raises and lowers the quantity in place', async () => {
    renderShop();
    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));

    fireEvent.press(screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' }));
    fireEvent.press(screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' }));
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('3');

    fireEvent.press(screen.getByRole('button', { name: 'Remove one Basmati Rice 5kg' }));
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('2');
    expect(useCartStore.getState().lines).toMatchObject([{ productId: RICE.id, quantity: 2 }]);
  });

  it('removes the item at one, and "Add" comes back', async () => {
    renderShop();
    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));

    fireEvent.press(screen.getByRole('button', { name: 'Remove one Basmati Rice 5kg' }));

    expect(useCartStore.getState().lines).toEqual([]);
    expect(screen.queryByTestId(`menu-stepper-${RICE.id}`)).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Basmati Rice 5kg' })).toBeOnTheScreen();
  });

  it('stops at the stock and says so in a toast, not by moving the page', async () => {
    serveShop(vendorMenu({ products: [menuProduct(RICE.id, RICE.name, RICE.unitPriceNpr, 2)] }));
    renderShop();
    fireEvent.press(await screen.findByRole('button', { name: 'Add Basmati Rice 5kg' }));
    fireEvent.press(screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' }));

    fireEvent.press(screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' }));

    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('2');
    expect(useToastStore.getState().toast).toMatchObject({ message: 'Maximum stock reached' });
    expect(screen.queryByTestId('menu-banner')).toBeNull();

    fireEvent.press(screen.getByRole('button', { name: 'Remove one Basmati Rice 5kg' }));
    expect(screen.getByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('1');
  });

  it('shows the stepper for what the cart already holds, per product', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 12 }, 4);
    renderShop();

    expect(await screen.findByTestId(`menu-quantity-${RICE.id}`)).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: `Add ${NOODLES.name}` })).toBeOnTheScreen();
  });

  it('cannot be used while a checkout is waiting for payment', async () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, { ...RICE, availableStock: 12 }, 2);
    useCheckoutStore.getState().startSession(checkoutResponse());
    renderShop();
    await screen.findByTestId(`menu-stepper-${RICE.id}`);

    const less = screen.getByRole('button', { name: 'Remove one Basmati Rice 5kg' });
    expect(less).toBeDisabled();
    fireEvent.press(less);
    fireEvent.press(screen.getByRole('button', { name: 'Add one Basmati Rice 5kg' }));

    expect(useCartStore.getState().lines).toMatchObject([{ quantity: 2 }]);
  });
});

describe('Menu row: product photo', () => {
  it('shows the branded placeholder for a product without a photo, and it opens nothing', async () => {
    renderShop();
    // The catalogue has arrived once the rice has its photo.
    await screen.findByTestId(`menu-product-photo-${RICE.id}`);

    expect(screen.getByTestId(`menu-product-placeholder-${NOODLES.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`menu-product-photo-${NOODLES.id}`)).toBeNull();
    expect(screen.queryByTestId(`menu-product-placeholder-${RICE.id}`)).toBeNull();
    expect(screen.queryByTestId('image-viewer')).toBeNull();
  });

  it('opens the photos full screen from the thumbnail, and closes again', async () => {
    renderShop();

    fireEvent.press(
      await screen.findByRole('imagebutton', { name: 'View photo of Basmati Rice 5kg' }),
    );

    const viewer = within(screen.getByTestId('image-viewer'));
    expect(viewer.getByTestId('image-viewer-photo-0').props.source).toEqual({ uri: RICE_PHOTO });
    expect(viewer.getByTestId('image-viewer-photo-1').props.source).toEqual({
      uri: 'https://cdn.test/rice-2.jpg',
    });
    expect(viewer.getByTestId('image-viewer-count')).toHaveTextContent('1 / 2');
    // Viewing a photo is not ordering, and not the detail sheet.
    expect(useCartStore.getState().lines).toEqual([]);
    expect(screen.queryByTestId('product-sheet')).toBeNull();

    fireEvent.press(viewer.getByRole('button', { name: 'Close photo' }));
    await waitFor(() => {
      expect(screen.queryByTestId('image-viewer')).toBeNull();
    });
  });

  it('shows the placeholder everywhere while the catalogue cannot be read', async () => {
    server.use(http.get(apiUrl(PRODUCTS_PATH), () => HttpResponse.json({}, { status: 500 })));
    renderShop();

    expect(await screen.findByTestId(`menu-product-placeholder-${RICE.id}`)).toBeOnTheScreen();
    expect(screen.getByTestId(`menu-product-placeholder-${NOODLES.id}`)).toBeOnTheScreen();
  });
});

describe('Shop header: favourite', () => {
  beforeEach(() => {
    useFavouritesStore.getState().resetFavourites();
  });

  it('saves the shop with the heart, and says so', async () => {
    renderShop();

    const heart = await screen.findByRole('button', { name: 'Add to favourites' });
    expect(heart).not.toBeSelected();
    fireEvent.press(heart);

    expect(useFavouritesStore.getState().favourites[THAMEL_VENDOR.id]).toMatchObject({
      vendorId: THAMEL_VENDOR.id,
      name: 'Thamel Kirana Pasal',
      location: 'Thamel, Kathmandu Metropolitan City',
    });
    expect(screen.getByRole('button', { name: 'Remove from favourites' })).toBeSelected();
    expect(useToastStore.getState().toast).toMatchObject({ message: 'Saved to your favourites.' });
  });

  it('removes a saved shop with the same heart', async () => {
    useFavouritesStore
      .getState()
      .toggleFavourite({ vendorId: THAMEL_VENDOR.id, name: 'Thamel Kirana Pasal', location: null });
    renderShop();

    fireEvent.press(await screen.findByRole('button', { name: 'Remove from favourites' }));

    expect(useFavouritesStore.getState().favourites).toEqual({});
    expect(screen.getByRole('button', { name: 'Add to favourites' })).toBeOnTheScreen();
  });
});

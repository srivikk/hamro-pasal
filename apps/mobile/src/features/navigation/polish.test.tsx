import { fireEvent, screen, within } from '@testing-library/react-native';
import { router } from 'expo-router';
import { http, HttpResponse } from 'msw';
import type { StateStorage } from 'zustand/middleware';

import FavouritesScreen from '../../../app/favourites';
import FeedScreen from '../../../app/(tabs)/(home)/index';
import ProfileScreen from '../../../app/(tabs)/profile';
import { VENDORS_PATH } from '../../api/catalog';
import { ConfirmModal } from '../../components/ConfirmModal';
import { FeedSkeleton, RowsSkeleton, ShopSkeleton } from '../../components/Skeleton';
import { VendorCard } from '../../components/VendorCard';
import { useAuthStore } from '../../store/useAuthStore';
import {
  createFavouritesStore,
  FAVOURITES_STORE_KEY,
  favouriteList,
  useFavouritesStore,
} from '../../store/useFavouritesStore';
import { feedResponse, PATAN_VENDOR, THAMEL_VENDOR } from '../../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { AddressBookModal } from '../address/AddressBookModal';
import { vendorExtras } from '../promo/mock-promotions';
import { NO_VENDOR_EXTRAS } from '../promo/promo-model';
import { tabResetAction, type TabsState } from './tab-reset';

jest.mock('expo-router', () => ({
  useFocusEffect: jest.fn(),
  router: { push: jest.fn() },
  Stack: { Screen: () => null },
  Redirect: () => null,
}));
jest.mock('../promo/mock-promotions', () => ({
  PROMO_MOCKS_ENABLED: true,
  homePromotions: jest.fn(() => ({ banners: [], offers: [] })),
  vendorExtras: jest.fn(),
  mockShopDiscountPaisa: jest.fn(() => 0),
}));

setupApiTestEnvironment();

beforeEach(() => {
  jest.clearAllMocks();
  useFavouritesStore.getState().resetFavourites();
  jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
});

describe('Shops tab: pressing it again returns to the feed', () => {
  const tabs = (index: number, homeStack?: { key?: string; index?: number }): TabsState => ({
    index,
    routes: [{ name: '(home)', state: homeStack }, { name: 'cart' }, { name: 'profile' }],
  });

  it('pops the tab’s own stack to its first screen when a shop is open in it', () => {
    expect(tabResetAction(tabs(0, { key: 'stack-abc', index: 1 }), '(home)')).toEqual({
      type: 'POP_TO_TOP',
      target: 'stack-abc',
    });
    expect(tabResetAction(tabs(0, { key: 'stack-abc', index: 3 }), '(home)')).toEqual({
      type: 'POP_TO_TOP',
      target: 'stack-abc',
    });
  });

  it('does nothing on the feed itself, or before the tab has a stack', () => {
    expect(tabResetAction(tabs(0, { key: 'stack-abc', index: 0 }), '(home)')).toBeNull();
    expect(tabResetAction(tabs(0), '(home)')).toBeNull();
    expect(tabResetAction(tabs(0, { index: 2 }), '(home)')).toBeNull();
  });

  it('leaves the stack alone when the press comes from another tab', () => {
    // From the Cart, "Shops" switches back to where the customer was.
    expect(tabResetAction(tabs(1, { key: 'stack-abc', index: 1 }), '(home)')).toBeNull();
  });
});

describe('My addresses: a Back arrow instead of "Done"', () => {
  it('closes from the arrow at the top left', () => {
    const onClose = jest.fn();
    renderWithProviders(<AddressBookModal visible onClose={onClose} />);

    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Back' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Home search placeholder', () => {
  it('says what can be searched for, starting with the first suggestion', () => {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
    renderWithProviders(<FeedScreen />);

    expect(screen.getByLabelText('Search for groceries, snacks or shops')).toBeOnTheScreen();
    expect(screen.getByTestId('product-search-hint')).toHaveTextContent('Search for groceries...');
  });

  it('puts the suggestion away as soon as something is typed', () => {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
    renderWithProviders(<FeedScreen />);

    fireEvent.changeText(screen.getByTestId('product-search'), 'tea');

    expect(screen.queryByTestId('product-search-hint')).toBeNull();
  });
});

describe('Vendor card: rating beside the name', () => {
  const entry = feedResponse().serviceable[0];
  if (entry === undefined) throw new Error('the feed fixture has no serviceable shop');

  it('shows the pill and the rounded count on the card, off the cover (the heart is there)', () => {
    jest
      .mocked(vendorExtras)
      .mockReturnValue({ ...NO_VENDOR_EXTRAS, rating_average: 4.1, rating_count: 237 });
    renderWithProviders(<VendorCard entry={entry} />);

    const shop = within(screen.getByTestId(`vendor-card-${THAMEL_VENDOR.id}`));
    expect(shop.getByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toHaveTextContent('4.1');
    expect(shop.getByTestId(`vendor-rating-${THAMEL_VENDOR.id}-count`)).toHaveTextContent('(200+)');
    const cover = within(screen.getByTestId(`vendor-cover-${THAMEL_VENDOR.id}`));
    expect(cover.queryByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toBeNull();
    expect(cover.getByTestId(`vendor-favourite-${THAMEL_VENDOR.id}`)).toBeOnTheScreen();
  });

  it('shows the pill alone without a count, and nothing without a rating', () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, rating_average: 4.1 });
    const { unmount } = renderWithProviders(<VendorCard entry={entry} />);
    expect(screen.getByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toBeOnTheScreen();
    expect(screen.queryByTestId(`vendor-rating-${THAMEL_VENDOR.id}-count`)).toBeNull();
    unmount();

    jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
    renderWithProviders(<VendorCard entry={entry} />);
    expect(screen.queryByTestId(`vendor-rating-${THAMEL_VENDOR.id}`)).toBeNull();
  });
});

describe('themed confirmation dialog', () => {
  it('shows its texts and reports the button pressed', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    renderWithProviders(
      <ConfirmModal
        visible
        title="Clear Cart?"
        message="Are you sure?"
        confirmLabel="Yes, Clear"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = within(screen.getByTestId('confirm-modal'));
    expect(dialog.getByText('Clear Cart?')).toBeOnTheScreen();
    expect(dialog.getByText('Are you sure?')).toBeOnTheScreen();
    fireEvent.press(dialog.getByRole('button', { name: 'Yes, Clear' }));
    fireEvent.press(dialog.getByRole('button', { name: 'Cancel' }));
    fireEvent.press(screen.getByTestId('confirm-modal-backdrop'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('renders nothing while hidden', () => {
    renderWithProviders(
      <ConfirmModal
        visible={false}
        title="Clear Cart?"
        message="Are you sure?"
        confirmLabel="Yes, Clear"
        cancelLabel="Cancel"
        onConfirm={jest.fn()}
        onCancel={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });
});

describe('skeleton loaders', () => {
  it('announce themselves as busy, under the id each loading state had', () => {
    renderWithProviders(
      <>
        <FeedSkeleton testID="feed-loading" />
        <RowsSkeleton testID="products-loading" rows={2} />
        <ShopSkeleton testID="menu-loading" />
      </>,
    );

    for (const id of ['feed-loading', 'products-loading', 'menu-loading']) {
      expect(screen.getByTestId(id)).toHaveProp('accessibilityRole', 'progressbar');
      expect(screen.getByTestId(id)).toHaveProp('accessibilityState', { busy: true });
    }
  });

  it('stands in for the Home feed while the shops load', () => {
    server.use(http.get(apiUrl(VENDORS_PATH), () => HttpResponse.json(feedResponse())));
    renderWithProviders(<FeedScreen />);

    expect(screen.getByTestId('feed-loading')).toHaveProp('accessibilityRole', 'progressbar');
  });
});

describe('favourites', () => {
  const thamel = { vendorId: THAMEL_VENDOR.id, name: 'Thamel Kirana Pasal', location: 'Thamel' };
  const patan = { vendorId: PATAN_VENDOR.id, name: 'Patan Organic Store', location: null };

  it('saves a shop, and removes it when toggled again', () => {
    const { toggleFavourite } = useFavouritesStore.getState();

    expect(toggleFavourite(thamel)).toBe(true);
    expect(toggleFavourite(patan)).toBe(true);
    expect(Object.keys(useFavouritesStore.getState().favourites)).toHaveLength(2);

    expect(toggleFavourite(thamel)).toBe(false);
    expect(Object.keys(useFavouritesStore.getState().favourites)).toEqual([PATAN_VENDOR.id]);
  });

  it('lists the newest first', () => {
    const list = favouriteList({
      a: { vendorId: 'a', name: 'A', location: null, savedAtMs: 1 },
      b: { vendorId: 'b', name: 'B', location: null, savedAtMs: 3 },
      c: { vendorId: 'c', name: 'C', location: null, savedAtMs: 2 },
    });

    expect(list.map((shop) => shop.vendorId)).toEqual(['b', 'c', 'a']);
  });

  it('restores what was stored and drops what is not a favourite', () => {
    const stored = JSON.stringify({
      version: 1,
      state: {
        favourites: {
          [THAMEL_VENDOR.id]: { ...thamel, savedAtMs: 5 },
          broken: { vendorId: '', name: 'x', location: null, savedAtMs: 1 },
          worse: 'nope',
        },
      },
    });
    const storage: StateStorage<void> = {
      getItem: (key) => (key === FAVOURITES_STORE_KEY ? stored : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(Object.keys(createFavouritesStore(storage).getState().favourites)).toEqual([
      THAMEL_VENDOR.id,
    ]);
  });

  it('is reached from the Profile tab by a signed-in customer; a guest has no such row', () => {
    const signedIn = renderWithProviders(<ProfileScreen />);
    fireEvent.press(screen.getByTestId('menu-favourites'));
    expect(jest.mocked(router.push)).toHaveBeenCalledWith('/favourites');
    signedIn.unmount();

    useAuthStore.getState().clearSession();
    renderWithProviders(<ProfileScreen />);

    expect(screen.queryByTestId('menu-favourites')).toBeNull();
  });

  it('lists the saved shops, opens one, and removes one with its heart', () => {
    useFavouritesStore.getState().toggleFavourite(thamel);
    useFavouritesStore.getState().toggleFavourite(patan);
    renderWithProviders(<FavouritesScreen />);

    const row = within(screen.getByTestId(`favourite-${THAMEL_VENDOR.id}`));
    expect(row.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(row.getByText('Thamel')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId(`favourite-open-${THAMEL_VENDOR.id}`));
    expect(jest.mocked(router.push)).toHaveBeenCalledWith({
      pathname: '/vendor/[id]',
      params: { id: THAMEL_VENDOR.id },
    });

    fireEvent.press(
      screen.getByRole('button', { name: 'Remove Patan Organic Store from favourites' }),
    );
    expect(screen.queryByTestId(`favourite-${PATAN_VENDOR.id}`)).toBeNull();
    expect(screen.getByTestId(`favourite-${THAMEL_VENDOR.id}`)).toBeOnTheScreen();
  });

  it('says so when nothing is saved', () => {
    renderWithProviders(<FavouritesScreen />);

    expect(screen.getByTestId('favourites-empty')).toHaveTextContent(
      'No favourites yet. Tap the heart on a shop to save it here.',
    );
  });
});

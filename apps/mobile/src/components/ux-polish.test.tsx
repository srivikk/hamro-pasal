import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type * as MockPromotionsModule from '../features/promo/mock-promotions';
import { vendorExtras } from '../features/promo/mock-promotions';
import type * as PromoModelModule from '../features/promo/promo-model';
import { NO_VENDOR_EXTRAS } from '../features/promo/promo-model';
import { useCartStore } from '../store/useCartStore';
import { useAuthStore } from '../store/useAuthStore';
import { useFavouritesStore } from '../store/useFavouritesStore';
import { useToastStore } from '../store/useToastStore';
import { feedResponse, NOODLES, THAMEL_VENDOR } from '../test/api-fixtures';
import { renderWithProviders } from '../test/render';
import { ProductImage } from './ProductImage';
import { RotatingPlaceholder } from './RotatingPlaceholder';
import { ToastHost } from './Toast';
import { VendorCard } from './VendorCard';

jest.mock('../features/promo/mock-promotions', () => {
  const actual = jest.requireActual<typeof MockPromotionsModule>(
    '../features/promo/mock-promotions',
  );
  const model = jest.requireActual<typeof PromoModelModule>('../features/promo/promo-model');
  return { ...actual, vendorExtras: jest.fn(() => model.NO_VENDOR_EXTRAS) };
});

const PHRASES = ['Search for rice...', 'Search for dal...', 'Search for tea...'];

/** One rotation: the wait, then the fade out and the fade in. */
function rotate(waitMs = 2000): void {
  act(() => {
    jest.advanceTimersByTime(waitMs);
  });
  act(() => {
    jest.advanceTimersByTime(600);
  });
}

describe('RotatingPlaceholder', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the first phrase, then the next every two seconds, and starts over', () => {
    renderWithProviders(<RotatingPlaceholder phrases={PHRASES} visible testID="hint" />);
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for rice...');

    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for rice...');

    rotate(1);
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for dal...');
    rotate(1400);
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for tea...');
    rotate(1400);
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for rice...');
  });

  it('runs no clock for a single phrase', () => {
    renderWithProviders(
      <RotatingPlaceholder phrases={['Search in this shop']} visible testID="hint" />,
    );

    expect(jest.getTimerCount()).toBe(0);
    expect(screen.getByTestId('hint')).toHaveTextContent('Search in this shop');
  });

  it('draws nothing and stops its clock while the field has text, and starts again after', () => {
    const clear = jest.spyOn(globalThis, 'clearInterval');
    const { rerender } = renderWithProviders(
      <RotatingPlaceholder phrases={PHRASES} visible testID="hint" />,
    );

    rerender(<RotatingPlaceholder phrases={PHRASES} visible={false} testID="hint" />);

    expect(screen.queryByTestId('hint')).toBeNull();
    expect(clear).toHaveBeenCalledTimes(1);

    // Cleared again: the phrase it stopped on is back, and the rotation resumes from it.
    rerender(<RotatingPlaceholder phrases={PHRASES} visible testID="hint" />);
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for rice...');
    rotate();
    expect(screen.getByTestId('hint')).toHaveTextContent('Search for dal...');
    clear.mockRestore();
  });

  it('clears its interval when it unmounts, also in the middle of a fade', () => {
    const clear = jest.spyOn(globalThis, 'clearInterval');
    const { unmount } = renderWithProviders(
      <RotatingPlaceholder phrases={PHRASES} visible testID="hint" />,
    );
    // The interval has fired and the fade out is under way.
    act(() => {
      jest.advanceTimersByTime(2100);
    });

    unmount();

    expect(clear).toHaveBeenCalledTimes(1);
    // Nothing is left to fire: no interval, and no fade that would set state on a gone component.
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(jest.getTimerCount()).toBe(0);
    clear.mockRestore();
  });
});

describe('ProductImage', () => {
  it('shows the photo when there is one', () => {
    renderWithProviders(
      <ProductImage
        uri="https://cdn.test/rice.jpg"
        soldOut={false}
        className="h-16 w-16"
        imageTestID="photo"
        placeholderTestID="placeholder"
      />,
    );

    expect(screen.getByTestId('photo').props.source).toEqual({ uri: 'https://cdn.test/rice.jpg' });
    expect(screen.queryByTestId('placeholder')).toBeNull();
    expect(screen.queryByTestId('out-of-stock-overlay')).toBeNull();
  });

  it.each([[null], [undefined], ['']])('falls back to the default tile for %p', (uri) => {
    renderWithProviders(
      <ProductImage
        uri={uri}
        soldOut={false}
        className="h-16 w-16"
        imageTestID="photo"
        placeholderTestID="placeholder"
      />,
    );

    expect(
      within(screen.getByTestId('placeholder')).getByTestId('icon-storefront-outline'),
    ).toBeTruthy();
    expect(screen.queryByTestId('photo')).toBeNull();
  });

  it('falls back when the photo does not load, and cannot be pressed then', () => {
    const onPress = jest.fn();
    renderWithProviders(
      <ProductImage
        uri="https://cdn.test/gone.jpg"
        soldOut={false}
        className="h-16 w-16"
        onPress={onPress}
        pressTestID="press"
        imageTestID="photo"
        placeholderTestID="placeholder"
      />,
    );
    fireEvent.press(screen.getByTestId('press'));
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent(screen.getByTestId('photo'), 'error', { nativeEvent: { error: '404' } });

    expect(screen.getByTestId('placeholder')).toBeOnTheScreen();
    expect(screen.queryByTestId('photo')).toBeNull();
    expect(screen.queryByTestId('press')).toBeNull();
  });

  it('veils a sold-out product, with or without a photo', () => {
    const { unmount } = renderWithProviders(
      <ProductImage uri="https://cdn.test/rice.jpg" soldOut className="h-16 w-16" />,
    );
    expect(
      within(screen.getByTestId('out-of-stock-overlay')).getByText('OUT OF STOCK'),
    ).toBeTruthy();
    unmount();

    renderWithProviders(<ProductImage uri={null} soldOut className="h-16 w-16" />);
    expect(
      within(screen.getByTestId('out-of-stock-overlay')).getByText('OUT OF STOCK'),
    ).toBeTruthy();
  });
});

describe('Vendor card: favourite heart and offer tag', () => {
  const [entry] = feedResponse().serviceable;
  if (entry === undefined) throw new Error('the feed fixture has no serviceable shop');
  const heart = () => screen.getByTestId(`vendor-favourite-${THAMEL_VENDOR.id}`);

  beforeEach(() => {
    useFavouritesStore.getState().resetFavourites();
    useToastStore.setState({ toast: null });
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, locality: 'Thamel' });
    // The heart is for signed-in customers (a guest sees none).
    useAuthStore.getState().setAccessToken('a.b.c');
  });
  afterEach(() => {
    useAuthStore.getState().clearSession();
  });

  it('saves the shop to the favourites without opening it, and says so', () => {
    const onPress = jest.fn();
    renderWithProviders(<VendorCard entry={entry} onPress={onPress} />);
    expect(heart()).not.toBeSelected();

    expect(heart()).toHaveProp('accessibilityLabel', 'Add to favourites');
    fireEvent.press(heart());

    expect(useFavouritesStore.getState().favourites[THAMEL_VENDOR.id]).toMatchObject({
      vendorId: THAMEL_VENDOR.id,
      name: 'Thamel Kirana Pasal',
      location: 'Thamel, Kathmandu Metropolitan City',
    });
    expect(heart()).toBeSelected();
    expect(within(heart()).getByTestId('icon-heart')).toBeTruthy();
    expect(useToastStore.getState().toast).toMatchObject({ message: 'Saved to your favourites.' });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('shows a shop saved elsewhere as saved, and removes it on a second press', () => {
    useFavouritesStore
      .getState()
      .toggleFavourite({ vendorId: THAMEL_VENDOR.id, name: 'Thamel Kirana Pasal', location: null });
    renderWithProviders(<VendorCard entry={entry} onPress={jest.fn()} />);

    expect(heart()).toHaveProp('accessibilityLabel', 'Remove from favourites');
    fireEvent.press(heart());

    expect(useFavouritesStore.getState().favourites).toEqual({});
    expect(within(heart()).getByTestId('icon-heart-outline')).toBeTruthy();
    expect(useToastStore.getState().toast).toMatchObject({
      message: 'Removed from your favourites.',
    });
  });

  it('can save a shop that does not deliver here (its card is otherwise disabled)', () => {
    renderWithProviders(
      <VendorCard entry={{ ...entry, serviceable: false }} onPress={jest.fn()} />,
    );

    fireEvent.press(heart());

    expect(useFavouritesStore.getState().favourites[THAMEL_VENDOR.id]).toBeDefined();
  });

  it('writes the offer as a small tag, and no tag without an offer', () => {
    jest.mocked(vendorExtras).mockReturnValue({ ...NO_VENDOR_EXTRAS, top_offer: 'Flat 10% OFF' });
    const { unmount } = renderWithProviders(<VendorCard entry={entry} />);
    expect(screen.getByTestId(`vendor-offer-${THAMEL_VENDOR.id}`)).toHaveTextContent(
      'Flat 10% OFF',
    );
    unmount();

    jest.mocked(vendorExtras).mockReturnValue(NO_VENDOR_EXTRAS);
    renderWithProviders(<VendorCard entry={entry} />);
    expect(screen.queryByTestId(`vendor-offer-${THAMEL_VENDOR.id}`)).toBeNull();
  });
});

describe('ToastHost position', () => {
  /** The distance from the bottom edge of whichever view around the toast positions it. */
  const bottomOf = (): number => {
    let node: ReturnType<typeof screen.getByTestId> | null = screen.getByTestId('toast');
    while (node !== null) {
      const style = StyleSheet.flatten((node.props as { style?: object }).style) as
        { bottom?: number } | undefined;
      if (typeof style?.bottom === 'number') return style.bottom;
      node = node.parent;
    }
    throw new Error('the toast is not positioned from the bottom');
  };

  beforeEach(() => {
    useToastStore.setState({ toast: null });
    useCartStore.getState().clearCart();
  });

  it('sits higher while the cart has items, clear of the cart bar', () => {
    renderWithProviders(<ToastHost />);
    act(() => {
      useToastStore.getState().show('Saved', 'info');
    });
    const empty = bottomOf();

    act(() => {
      useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 1);
    });

    expect(bottomOf()).toBe(empty + 56);
  });
});

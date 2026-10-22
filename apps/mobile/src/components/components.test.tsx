import type { FeedEntry } from '@hamro-pasal/shared-types';
import { fireEvent, screen } from '@testing-library/react-native';

import { useCartStore } from '../store/useCartStore';
import { renderWithProviders } from '../test/render';
import { Button } from './Button';
import { ReplaceCartModal } from './ReplaceCartModal';
import { VendorCard } from './VendorCard';

const vendor: FeedEntry['vendor'] = {
  id: 'vendor-1',
  business_name: 'Thamel Kirana Pasal',
  delivery_scope: 'RADIUS_BOUND',
  radius_km: 5,
  municipality_palika_string: 'Kathmandu Metropolitan City',
  min_order_value: 500,
  base_delivery_fee_npr: 50,
  free_delivery_above_npr: null,
  fulfillment_mode: 'SELF_DELIVERY',
  location: { x: 85.3123, y: 27.7154 },
  rating_average: null,
  rating_count: 0,
};

describe('Button', () => {
  it('fires onPress and exposes its label to screen readers', () => {
    const onPress = jest.fn();
    renderWithProviders(<Button label="Add" onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Add' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit accessibility label', () => {
    renderWithProviders(<Button label="+" accessibilityLabel="Add one rice" onPress={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'Add one rice' })).toBeOnTheScreen();
  });

  it('does not fire when disabled', () => {
    const onPress = jest.fn();
    renderWithProviders(<Button label="Add" disabled onPress={onPress} />);

    fireEvent.press(screen.getByRole('button', { name: 'Add' }));

    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });
});

describe('VendorCard', () => {
  const entry = (rating: Partial<FeedEntry['vendor']>): FeedEntry => ({
    vendor: { ...vendor, ...rating },
    distance_km: 1.26,
    serviceable: true,
    delivery_available: true,
    is_sponsored: false,
    open_now: true,
    closed_reason: null,
  });

  it("shows the server's rating of the shop, and none before its first (2026-10-21)", () => {
    const view = renderWithProviders(
      <VendorCard entry={entry({ rating_average: 4.5, rating_count: 12 })} />,
    );
    expect(screen.getByTestId('vendor-rating-vendor-1')).toHaveTextContent(/4\.5/);
    // The count is shown rounded down to a round figure (12 -> "(10+)").
    expect(screen.getByTestId('vendor-rating-vendor-1-count')).toHaveTextContent('(10+)');

    view.rerender(<VendorCard entry={entry({ rating_average: null, rating_count: 0 })} />);
    expect(screen.queryByTestId('vendor-rating-vendor-1')).toBeNull();
  });

  it('shows vendor details and responds to taps when serviceable', () => {
    const onPress = jest.fn();
    renderWithProviders(
      <VendorCard
        entry={{
          vendor,
          distance_km: 1.26,
          serviceable: true,
          delivery_available: true,
          is_sponsored: false,
          open_now: true,
          closed_reason: null,
        }}
        onPress={onPress}
      />,
    );

    expect(screen.getByText('Thamel Kirana Pasal')).toBeOnTheScreen();
    expect(screen.getByText('1.3 km away')).toBeOnTheScreen();
    expect(screen.getByText('Delivers within 5 km')).toBeOnTheScreen();
    expect(screen.getByText('Delivery Rs. 50')).toBeOnTheScreen();
    expect(screen.getByText('Min. order Rs. 500')).toBeOnTheScreen();
    expect(screen.queryByText("Doesn't deliver to you")).toBeNull();

    fireEvent.press(screen.getByTestId('vendor-card-vendor-1'));
    expect(onPress).toHaveBeenCalledWith('vendor-1');
  });

  it('marks a shop closed by its hours, and still opens it for browsing (step 7.3)', () => {
    const onPress = jest.fn();
    renderWithProviders(
      <VendorCard
        entry={{
          vendor,
          distance_km: 1.26,
          serviceable: true,
          delivery_available: true,
          is_sponsored: false,
          open_now: false,
          closed_reason: 'HOURS',
        }}
        onPress={onPress}
      />,
    );

    expect(screen.getByTestId('vendor-closed-vendor-1')).toHaveTextContent('Closed now');
    fireEvent.press(screen.getByTestId('vendor-card-vendor-1'));
    expect(onPress).toHaveBeenCalledWith('vendor-1');
  });

  it('is disabled and badged in Explore Further', () => {
    const onPress = jest.fn();
    renderWithProviders(
      <VendorCard
        entry={{
          vendor,
          distance_km: 9,
          serviceable: false,
          delivery_available: true,
          is_sponsored: false,
          open_now: true,
          closed_reason: null,
        }}
        onPress={onPress}
      />,
    );

    const card = screen.getByTestId('vendor-card-vendor-1');
    fireEvent.press(card);

    expect(onPress).not.toHaveBeenCalled();
    expect(card).toBeDisabled();
    expect(screen.getByText("Doesn't deliver to you")).toBeOnTheScreen();
  });

  it('renders every number in Devanagari under ne', () => {
    renderWithProviders(
      <VendorCard
        entry={{
          vendor,
          distance_km: 2.04,
          serviceable: true,
          delivery_available: true,
          is_sponsored: false,
          open_now: true,
          closed_reason: null,
        }}
      />,
      {
        locale: 'ne',
      },
    );

    expect(screen.getByText('२ कि.मी. टाढा')).toBeOnTheScreen();
    expect(screen.getByText('५ कि.मी. भित्र डेलिभरी')).toBeOnTheScreen();
    expect(screen.getByText('डेलिभरी शुल्क रु. ५०')).toBeOnTheScreen();
    expect(screen.getByText('न्यूनतम अर्डर रु. ५००')).toBeOnTheScreen();
  });

  it.each([
    ['CITY_WIDE', 'Delivers across Kathmandu Metropolitan City'],
    ['NATION_WIDE', 'Delivers nationwide'],
  ] as const)('describes the %s scope', (scope, label) => {
    renderWithProviders(
      <VendorCard
        entry={{
          vendor: { ...vendor, delivery_scope: scope },
          distance_km: 1,
          serviceable: true,
          delivery_available: true,
          is_sponsored: false,
          open_now: true,
          closed_reason: null,
        }}
      />,
    );

    expect(screen.getByText(label)).toBeOnTheScreen();
  });
});

describe('ReplaceCartModal', () => {
  const thamel = {
    id: 'v-thamel',
    name: 'Thamel Kirana Pasal',
    deliveryFeeNpr: 50,
    minOrderValueNpr: 0,
  };
  const patan = {
    id: 'v-patan',
    name: 'Patan Organic Store',
    deliveryFeeNpr: 80,
    minOrderValueNpr: 0,
  };
  const rice = { id: 'p-rice', name: 'Rice', unitPriceNpr: 120 };
  const honey = { id: 'p-honey', name: 'Honey', unitPriceNpr: 650 };

  beforeEach(() => {
    useCartStore.getState().clearCart();
  });

  it('stays hidden without a vendor conflict', () => {
    useCartStore.getState().addItem(thamel, rice);
    renderWithProviders(<ReplaceCartModal />);

    expect(screen.queryByText('Replace cart items?')).toBeNull();
  });

  it('names both vendors and replaces the cart on confirm', () => {
    useCartStore.getState().addItem(thamel, rice);
    useCartStore.getState().addItem(patan, honey);
    renderWithProviders(<ReplaceCartModal />);

    expect(
      screen.getByText(
        'Your cart contains items from Thamel Kirana Pasal. Do you want to discard them to start a new order with Patan Organic Store?',
      ),
    ).toBeOnTheScreen();

    fireEvent.press(screen.getByRole('button', { name: 'Clear Cart' }));

    expect(useCartStore.getState().vendor).toEqual(patan);
    expect(useCartStore.getState().lines.map((line) => line.productId)).toEqual([honey.id]);
    expect(screen.queryByText('Replace cart items?')).toBeNull();
  });

  it('keeps the current cart on cancel', () => {
    useCartStore.getState().addItem(thamel, rice);
    useCartStore.getState().addItem(patan, honey);
    renderWithProviders(<ReplaceCartModal />);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));

    expect(useCartStore.getState().vendor).toEqual(thamel);
    expect(useCartStore.getState().pendingAddition).toBeNull();
    expect(screen.queryByText('Replace cart items?')).toBeNull();
  });
});

import { screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { VendorCard } from '../components/VendorCard';
import { TodaySummaryCard } from '../features/vendor/TodaySummaryCard';
import { VendorOrderCard } from '../features/vendor/VendorOrderCard';
import { setAppVariantForTests } from '../lib/app-variant';
import { useCartStore } from '../store/useCartStore';
import { feedResponse, NOODLES, THAMEL_VENDOR, vendorOrder } from '../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment } from '../test/msw';
import { renderWithProviders } from '../test/render';
import { BasketLoader, BrandLockup, MadeInNepal, STATUS_TONES, StatusChip } from './index';

setupApiTestEnvironment();

afterEach(() => {
  setAppVariantForTests('CUSTOMER');
});

describe('"Sajilo cha hai" brand components', () => {
  it('shows the customer name and tagline, and the Seller name and tagline in the Seller build', () => {
    const { unmount } = renderWithProviders(<BrandLockup />);
    expect(screen.getByLabelText('Hamro Pasal')).toBeOnTheScreen();
    expect(screen.getByTestId('brand-tagline')).toHaveTextContent('~ Sajilo cha hai ~');
    unmount();

    setAppVariantForTests('SELLER');
    renderWithProviders(<BrandLockup />);
    expect(screen.getByLabelText('Hamro Pasal Seller')).toBeOnTheScreen();
    expect(screen.getByTestId('brand-tagline')).toHaveTextContent('~ Hamro sajha byapar ~');
  });

  it('says "Made in Nepal", in Nepali under ne', () => {
    const { unmount } = renderWithProviders(<MadeInNepal />);
    expect(screen.getByText('Made in Nepal')).toBeOnTheScreen();
    unmount();
    renderWithProviders(<MadeInNepal />, { locale: 'ne' });
    expect(screen.getByText('नेपालमा बनेको')).toBeOnTheScreen();
  });

  it('announces the basket loader as progress, with or without its caption', () => {
    const { unmount } = renderWithProviders(<BasketLoader />);
    expect(screen.getByRole('progressbar', { name: 'Sajilo cha hai…' })).toBeOnTheScreen();
    expect(screen.getByText('Sajilo cha hai…')).toBeOnTheScreen();
    unmount();
    renderWithProviders(<BasketLoader label={false} />);
    expect(screen.queryByText('Sajilo cha hai…')).toBeNull();
  });
});

describe('the order colour code', () => {
  it('gives each status its own colour: marigold new, Himalayan blue preparing, green dispatched', () => {
    expect(STATUS_TONES.new.chip).toContain('marigold');
    expect(STATUS_TONES.preparing.chip).toContain('himalaya');
    expect(STATUS_TONES.dispatched.chip).toContain('nepal');
    renderWithProviders(<StatusChip label="New" tone="new" testID="chip" />);
    expect(screen.getByTestId('chip')).toHaveTextContent('New');
  });

  it.each([
    ['PLACED', 'New', 'marigold'],
    ['PREPARING', 'Preparing', 'himalaya'],
    ['OUT_FOR_DELIVERY', 'Ready', 'nepal'],
  ] as const)('marks a %s order "%s" and colours its card %s', (state, label, hue) => {
    const order = vendorOrder({ state });
    const noop = jest.fn();
    renderWithProviders(
      <VendorOrderCard
        order={order}
        answered={false}
        onAccept={noop}
        onReject={noop}
        dispatching={false}
        onDispatch={noop}
        delivering={false}
        onDeliver={noop}
      />,
    );
    expect(screen.getByTestId(`order-status-${order.id}`)).toHaveTextContent(label);
    expect(String(screen.getByTestId(`vendor-order-${order.id}`).props.className)).toContain(
      `border-${hue}`,
    );
  });
});

describe("the Seller dashboard's summary card", () => {
  it("shows the server's figures for today", async () => {
    server.use(
      http.get(apiUrl('/api/vendor/analytics/summary'), () =>
        HttpResponse.json({
          today_sales_npr: 18450,
          today_order_count: 10,
          top_item: null,
          ad_roi: null,
          daily_sales: ['THU', 'FRI', 'SAT', 'SUN', 'MON', 'TUE', 'WED'].map((day) => ({
            day,
            sales_npr: 0,
          })),
        }),
      ),
    );
    renderWithProviders(<TodaySummaryCard />);
    expect(await screen.findByTestId('vendor-today-sales')).toHaveTextContent('Rs. 18450');
    expect(screen.getByTestId('vendor-today-orders')).toHaveTextContent('10 orders');
  });

  it('shows nothing until the server has answered, and nothing when it cannot', async () => {
    server.use(
      http.get(apiUrl('/api/vendor/analytics/summary'), () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 }),
      ),
    );
    renderWithProviders(<TodaySummaryCard />);
    await waitFor(() => {
      expect(screen.queryByTestId('vendor-today-summary')).toBeNull();
    });
  });
});

describe("the shop card's cart chip", () => {
  const entry = feedResponse().serviceable.find((e) => e.vendor.id === THAMEL_VENDOR.id);
  if (entry === undefined) throw new Error('the feed fixture has no Thamel shop');

  it('appears on the shop whose items are in the cart, with the item count', () => {
    useCartStore.getState().addItem(THAMEL_VENDOR, NOODLES, 3);
    renderWithProviders(<VendorCard entry={entry} onPress={jest.fn()} />);
    expect(screen.getByTestId(`vendor-cart-${THAMEL_VENDOR.id}`)).toHaveTextContent(
      '3 items in cart',
    );
  });

  it('is absent with an empty cart', () => {
    renderWithProviders(<VendorCard entry={entry} onPress={jest.fn()} />);
    expect(screen.queryByTestId(`vendor-cart-${THAMEL_VENDOR.id}`)).toBeNull();
  });
});

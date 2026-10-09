import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorAnalyticsScreen from '../../../app/(vendor)/analytics';
import { fetchVendorAnalytics } from '../../api/vendor-analytics';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import { adRoiRatio, BAR_HEIGHT_CLASSES, barStep } from './analytics-format';

setupApiTestEnvironment();

const SUMMARY_PATH = '/api/vendor/analytics/summary';

/** A summary as the server sends it. */
const summary = (overrides: Record<string, unknown> = {}) => ({
  today_sales_npr: 12_450,
  today_order_count: 9,
  top_item: { product_name: 'Wai Wai Noodles (pack of 30)', units_sold: 14, sales_npr: 8400 },
  ad_roi: { spend_npr: 1200, revenue_npr: 5400 },
  daily_sales: [
    { day: 'THU', sales_npr: 6200 },
    { day: 'FRI', sales_npr: 9800 },
    { day: 'SAT', sales_npr: 15_300 },
    { day: 'SUN', sales_npr: 7400 },
    { day: 'MON', sales_npr: 0 },
    { day: 'TUE', sales_npr: 10_150 },
    { day: 'WED', sales_npr: 12_450 },
  ],
  ...overrides,
});

/** Serves the summary and records every request for it. */
function serve(answer: () => Response = () => HttpResponse.json(summary())) {
  const requests: CapturedRequest[] = [];
  server.use(
    http.get(apiUrl(SUMMARY_PATH), async ({ request }) => {
      requests.push(await capture(request));
      return answer();
    }),
  );
  return requests;
}

describe('analytics helpers', () => {
  it('gives the ad return as sales per rupee spent, to one decimal', () => {
    expect(adRoiRatio({ spend_npr: 1200, revenue_npr: 5400 })).toBe(4.5);
    expect(adRoiRatio({ spend_npr: 300, revenue_npr: 1000 })).toBe(3.3);
    expect(adRoiRatio({ spend_npr: 0, revenue_npr: 500 })).toBeNull();
    expect(adRoiRatio(null)).toBeNull();
  });

  it('gives the best day the tallest bar, a day without sales the flat one, and never hides a sale', () => {
    const top = BAR_HEIGHT_CLASSES.length - 1;
    expect(barStep(15_300, 15_300)).toBe(top);
    expect(barStep(0, 15_300)).toBe(0);
    expect(barStep(10, 15_300)).toBe(1);
    expect(barStep(7650, 15_300)).toBe(4);
    expect(barStep(500, 0)).toBe(0);
  });
});

describe('GET /api/vendor/analytics/summary', () => {
  it('is asked with the session, and its answer is held to the shared contract', async () => {
    const requests = serve();

    await expect(fetchVendorAnalytics()).resolves.toMatchObject({ today_sales_npr: 12_450 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.headers.get('authorization')).toMatch(/^Bearer /);
    expect(requests[0]?.url.search).toBe('');
  });

  it('refuses a summary that breaks the contract instead of drawing it', async () => {
    serve(() => HttpResponse.json(summary({ daily_sales: [{ day: 'WED', sales_npr: 10 }] })));
    await expect(fetchVendorAnalytics()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });

    serve(() => HttpResponse.json(summary({ today_sales_npr: -5 })));
    await expect(fetchVendorAnalytics()).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });
});

describe('Analytics screen', () => {
  it('shows a skeleton while the figures load, then the three metric cards from the server', async () => {
    serve();
    renderWithProviders(<VendorAnalyticsScreen />);

    expect(screen.getByTestId('analytics-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('metric-sales')).not.toBeOnTheScreen();

    expect(await screen.findByTestId('metric-sales')).toBeOnTheScreen();
    expect(screen.queryByTestId('analytics-loading')).not.toBeOnTheScreen();

    expect(screen.getByText("Today's Sales")).toBeOnTheScreen();
    expect(screen.getByTestId('metric-sales-value')).toHaveTextContent('Rs. 12450');
    expect(screen.getByText('9 orders')).toBeOnTheScreen();

    expect(screen.getByText('Top Performing Item')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-top-item-value')).toHaveTextContent(
      'Wai Wai Noodles (pack of 30)',
    );
    expect(screen.getByText('14 sold · Rs. 8400')).toBeOnTheScreen();

    expect(screen.getByText('Ad ROI')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-ad-roi-value')).toHaveTextContent('4.5×');
    expect(screen.getByText('Rs. 5400 in sales for Rs. 1200 of ads')).toBeOnTheScreen();
    // No sample figures are left on the screen.
    expect(screen.queryByTestId('analytics-sample-note')).not.toBeOnTheScreen();
  });

  it('draws the last seven days as bars: tallest for the best day, today highlighted', async () => {
    serve();
    renderWithProviders(<VendorAnalyticsScreen />);
    await screen.findByTestId('analytics-chart');

    const bar = (index: number): string =>
      String(screen.getByTestId(`analytics-bar-${String(index)}`).props.className);

    expect(screen.getAllByTestId(/^analytics-bar-/)).toHaveLength(7);
    expect(bar(2)).toContain('h-28'); // Saturday, the best day
    expect(bar(4)).toContain('h-1'); // Monday, no sales
    expect(bar(6)).toContain('bg-brand'); // today
    expect(bar(2)).not.toContain('bg-brand');
    expect(screen.getByTestId('analytics-bar-2').props.accessibilityLabel).toBe('Sat: Rs. 15300');
  });

  it('shows a new shop as it is: nothing sold, no top item, no ad, seven flat bars', async () => {
    serve(() =>
      HttpResponse.json(
        summary({
          today_sales_npr: 0,
          today_order_count: 0,
          top_item: null,
          ad_roi: null,
          daily_sales: summary().daily_sales.map((day) => ({ ...day, sales_npr: 0 })),
        }),
      ),
    );
    renderWithProviders(<VendorAnalyticsScreen />);

    expect(await screen.findByTestId('metric-sales-value')).toHaveTextContent('Rs. 0');
    expect(screen.getByText('0 orders')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-top-item-value')).toHaveTextContent('–');
    expect(screen.getByText('Nothing delivered in the last 7 days.')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-ad-roi-value')).toHaveTextContent('–');
    expect(screen.getByText('No ads in the last 30 days.')).toBeOnTheScreen();
    for (const bar of screen.getAllByTestId(/^analytics-bar-/)) {
      expect(String(bar.props.className)).toContain('h-1 ');
    }
  });

  it('gives no ratio for an ad that has cost nothing yet, but says what it brought', async () => {
    serve(() => HttpResponse.json(summary({ ad_roi: { spend_npr: 0, revenue_npr: 900 } })));
    renderWithProviders(<VendorAnalyticsScreen />);

    expect(await screen.findByTestId('metric-ad-roi-value')).toHaveTextContent('–');
    expect(
      screen.getByText('Rs. 900 in sales while your ad ran. No ad fees charged yet.'),
    ).toBeOnTheScreen();
  });

  it('says so when the figures cannot be loaded, and loads them on Try again', async () => {
    let fail = true;
    const requests = serve(() =>
      fail
        ? HttpResponse.json(
            { error: { code: 'VENDOR_NOT_FOUND', message: 'no shop' } },
            { status: 404 },
          )
        : HttpResponse.json(summary()),
    );
    renderWithProviders(<VendorAnalyticsScreen />);

    expect(await screen.findByTestId('analytics-error')).toHaveTextContent(
      "Couldn't load your analytics. Check your connection and try again.",
    );
    expect(screen.queryByTestId('metric-sales')).not.toBeOnTheScreen();
    // A refusal that cannot succeed on retry is asked once.
    expect(requests).toHaveLength(1);

    fail = false;
    fireEvent.press(screen.getByTestId('analytics-retry'));

    expect(await screen.findByTestId('metric-sales-value')).toHaveTextContent('Rs. 12450');
    expect(requests).toHaveLength(2);
  });

  it('keeps the last figures, marked as such, when a refresh fails', async () => {
    let fail = false;
    serve(() =>
      fail
        ? HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'no' } }, { status: 403 })
        : HttpResponse.json(summary()),
    );
    renderWithProviders(<VendorAnalyticsScreen />);
    await screen.findByTestId('metric-sales');
    expect(screen.queryByTestId('analytics-stale')).not.toBeOnTheScreen();

    fail = true;
    const { refreshControl } = screen.getByTestId('vendor-analytics').props as {
      refreshControl: { props: { onRefresh: () => void } };
    };
    refreshControl.props.onRefresh();

    await waitFor(() => {
      expect(screen.getByTestId('analytics-stale')).toBeOnTheScreen();
    });
    expect(screen.getByTestId('metric-sales-value')).toHaveTextContent('Rs. 12450');
  });

  it('reads Nepali under ne', async () => {
    serve();
    renderWithProviders(<VendorAnalyticsScreen />, { locale: 'ne' });

    expect(await screen.findByText('आजको बिक्री')).toBeOnTheScreen();
    expect(screen.getByTestId('metric-sales-value')).toHaveTextContent('रु. १२४५०');
  });
});

import { screen } from '@testing-library/react-native';

import VendorAnalyticsScreen from '../../../app/(vendor)/analytics';
import { renderWithProviders } from '../../test/render';
import { adRoiRatio, BAR_HEIGHT_CLASSES, barStep } from './mock-analytics';

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

describe('Analytics screen', () => {
  it('shows a skeleton while the figures load, then the three metric cards', async () => {
    renderWithProviders(<VendorAnalyticsScreen />);

    expect(screen.getByTestId('analytics-loading')).toBeOnTheScreen();
    expect(screen.queryByTestId('metric-sales')).not.toBeOnTheScreen();

    expect(await screen.findByTestId('metric-sales', {}, { timeout: 3000 })).toBeOnTheScreen();
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
    expect(screen.getByTestId('analytics-sample-note')).toBeOnTheScreen();
  });

  it('draws the last seven days as bars: tallest for the best day, today highlighted', async () => {
    renderWithProviders(<VendorAnalyticsScreen />);
    await screen.findByTestId('analytics-chart', {}, { timeout: 3000 });

    const bar = (index: number): string =>
      String(screen.getByTestId(`analytics-bar-${String(index)}`).props.className);

    expect(screen.getAllByTestId(/^analytics-bar-/)).toHaveLength(7);
    expect(bar(2)).toContain('h-28'); // Saturday, the best day
    expect(bar(4)).toContain('h-1'); // Monday, no sales
    expect(bar(6)).toContain('bg-brand'); // today
    expect(bar(2)).not.toContain('bg-brand');
    expect(screen.getByTestId('analytics-bar-2').props.accessibilityLabel).toBe('Sat: Rs. 15300');
  });

  it('reads Nepali under ne', async () => {
    renderWithProviders(<VendorAnalyticsScreen />, { locale: 'ne' });

    expect(await screen.findByText('आजको बिक्री', {}, { timeout: 3000 })).toBeOnTheScreen();
    expect(screen.getByTestId('metric-sales-value')).toHaveTextContent('रु. १२४५०');
  });
});

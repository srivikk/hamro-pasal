import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { retryTransientFailures } from '../../api/query-client';
import { fetchVendorAnalytics, VENDOR_ANALYTICS_QUERY_KEY } from '../../api/vendor-analytics';

/**
 * The red card at the top of the Seller dashboard ("Sajilo cha hai" mockup): today's sales and
 * today's delivered orders, both the server's figures (GET /api/vendor/analytics/summary, Nepal
 * Time). It shares the Analytics screen's cache entry, and shows nothing until it has an answer:
 * a figure is never guessed on the phone.
 */
export function TodaySummaryCard() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: VENDOR_ANALYTICS_QUERY_KEY,
    queryFn: fetchVendorAnalytics,
    staleTime: 60_000,
    retry: retryTransientFailures,
  });
  const summary = query.data;
  if (summary === undefined) return null;

  return (
    <View
      className="mx-4 mt-3 flex-row rounded-card-lg bg-brand p-4 shadow-sm"
      testID="vendor-today-summary"
    >
      <View className="flex-1 gap-0.5 border-r border-white/25 pr-4">
        <Text className="font-body-medium text-sm text-white/85">
          {t('vendorBoard.todaySales')}
        </Text>
        <Text className="font-display text-2xl text-white" testID="vendor-today-sales">
          {t('order.total', { amount: summary.today_sales_npr })}
        </Text>
      </View>
      <View className="gap-0.5 pl-4">
        <Text className="font-body-medium text-sm text-white/85">
          {t('vendorBoard.todayOrders')}
        </Text>
        <Text className="font-display text-2xl text-white" testID="vendor-today-orders">
          {t('vendorBoard.ordersUnit', { count: summary.today_order_count })}
        </Text>
      </View>
    </View>
  );
}

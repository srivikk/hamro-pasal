import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { retryTransientFailures } from '../../src/api/query-client';
import { fetchVendorAnalytics, VENDOR_ANALYTICS_QUERY_KEY } from '../../src/api/vendor-analytics';
import { Button } from '../../src/components/Button';
import { SkeletonBlock, SkeletonGroup } from '../../src/components/Skeleton';
import {
  adRoiRatio,
  BAR_HEIGHT_CLASSES,
  barStep,
} from '../../src/features/vendor/analytics-format';
import { colors } from '../../src/theme/colors';

export { VENDOR_ANALYTICS_QUERY_KEY };

const cardClass = 'gap-1 rounded-2xl bg-white p-4 shadow-sm';

function MetricCard({
  testID,
  icon,
  label,
  value,
  detail,
}: {
  testID: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <View className={cardClass} testID={testID}>
      <View className="flex-row items-center gap-2">
        <Ionicons name={icon} size={18} color={colors.inactive} />
        <Text className="text-sm text-gray-500">{label}</Text>
      </View>
      <Text className="text-2xl font-bold text-gray-900" testID={`${testID}-value`}>
        {value}
      </Text>
      <Text className="text-sm text-gray-500">{detail}</Text>
    </View>
  );
}

/** The shape of what is coming: three metric cards and the chart. */
function AnalyticsSkeleton() {
  return (
    <SkeletonGroup testID="analytics-loading">
      <View className="gap-3 p-4">
        {[0, 1, 2].map((card) => (
          <View key={card} className="gap-2 rounded-2xl bg-white p-4">
            <SkeletonBlock className="h-4 w-1/3 rounded" />
            <SkeletonBlock className="h-7 w-1/2 rounded" />
            <SkeletonBlock className="h-3 w-2/3 rounded" />
          </View>
        ))}
        <View className="gap-3 rounded-2xl bg-white p-4">
          <SkeletonBlock className="h-4 w-1/3 rounded" />
          <SkeletonBlock className="h-28 rounded" />
        </View>
      </View>
    </SkeletonGroup>
  );
}

/**
 * A first look at how the shop is doing: today's sales, the best-selling item, what the ads
 * returned, and the last seven days as bars. Opened from the chart icon in the Ledger header.
 *
 * Every figure is the server's (`GET /api/vendor/analytics/summary`, Phase 35): sales are the
 * delivered subtotal less the shop's own discounts, and a day is a day in Nepal Time. Nothing is
 * computed or remembered on the phone; the screen refetches when it is opened and on pull.
 */
export default function VendorAnalyticsScreen() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: VENDOR_ANALYTICS_QUERY_KEY,
    queryFn: fetchVendorAnalytics,
    staleTime: 0,
    retry: retryTransientFailures,
  });

  if (query.data === undefined && query.isError) {
    return (
      <View
        className="flex-1 items-center justify-center gap-3 bg-gray-50 p-6"
        testID="vendor-analytics"
      >
        <Ionicons name="cloud-offline-outline" size={32} color={colors.inactive} />
        <Text className="text-center text-base text-gray-700" testID="analytics-error">
          {t('vendorAnalytics.loadError')}
        </Text>
        <Button
          testID="analytics-retry"
          label={t('vendorAnalytics.retry')}
          variant="secondary"
          onPress={() => {
            void query.refetch();
          }}
        />
      </View>
    );
  }
  if (query.data === undefined) {
    return (
      <View className="flex-1 bg-gray-50" testID="vendor-analytics">
        <AnalyticsSkeleton />
      </View>
    );
  }

  const analytics = query.data;
  const ratio = adRoiRatio(analytics.ad_roi);
  const best = Math.max(...analytics.daily_sales.map((day) => day.sales_npr));

  return (
    <ScrollView
      className="flex-1 bg-gray-50"
      contentContainerStyle={{ padding: 16, gap: 12 }}
      testID="vendor-analytics"
      refreshControl={
        <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
      }
    >
      {query.isError ? (
        // A refresh failed: the figures below are the last ones the server sent.
        <Text className="text-sm text-amber-700" testID="analytics-stale">
          {t('vendorAnalytics.stale')}
        </Text>
      ) : null}

      <MetricCard
        testID="metric-sales"
        icon="cash-outline"
        label={t('vendorAnalytics.todaySales')}
        value={t('common.price', { amount: analytics.today_sales_npr })}
        detail={t('vendorAnalytics.orders', { count: analytics.today_order_count })}
      />
      <MetricCard
        testID="metric-top-item"
        icon="trophy-outline"
        label={t('vendorAnalytics.topItem')}
        value={analytics.top_item?.product_name ?? t('vendorAnalytics.none')}
        detail={
          analytics.top_item === null
            ? t('vendorAnalytics.noTopItem')
            : t('vendorAnalytics.topItemDetail', {
                units: analytics.top_item.units_sold,
                amount: analytics.top_item.sales_npr,
              })
        }
      />
      <MetricCard
        testID="metric-ad-roi"
        icon="megaphone-outline"
        label={t('vendorAnalytics.adRoi')}
        value={
          ratio === null ? t('vendorAnalytics.none') : t('vendorAnalytics.roiValue', { ratio })
        }
        detail={
          analytics.ad_roi === null
            ? t('vendorAnalytics.noAds')
            : ratio === null
              ? // An ad ran, but no fee has been charged for it yet: there is no ratio to show.
                t('vendorAnalytics.roiNoSpend', { revenue: analytics.ad_roi.revenue_npr })
              : t('vendorAnalytics.roiDetail', {
                  revenue: analytics.ad_roi.revenue_npr,
                  spend: analytics.ad_roi.spend_npr,
                })
        }
      />

      <View className={cardClass} testID="analytics-chart">
        <Text className="text-sm text-gray-500">{t('vendorAnalytics.weekTitle')}</Text>
        <View className="mt-2 h-28 flex-row items-end gap-2">
          {analytics.daily_sales.map((day, index) => {
            const step = barStep(day.sales_npr, best);
            const today = index === analytics.daily_sales.length - 1;
            return (
              <View
                key={`${day.day}-${String(index)}`}
                testID={`analytics-bar-${String(index)}`}
                accessibilityLabel={t('vendorAnalytics.barLabel', {
                  day: t(`vendorAnalytics.days.${day.day}`),
                  amount: day.sales_npr,
                })}
                className={`flex-1 rounded-t ${BAR_HEIGHT_CLASSES[step] ?? 'h-1'} ${today ? 'bg-brand' : 'bg-gray-300'}`}
              />
            );
          })}
        </View>
        <View className="flex-row gap-2">
          {analytics.daily_sales.map((day, index) => (
            <Text
              key={`${day.day}-${String(index)}`}
              className="flex-1 text-center text-xs text-gray-500"
            >
              {t(`vendorAnalytics.days.${day.day}`)}
            </Text>
          ))}
        </View>
      </View>
    </ScrollView>
  );
}

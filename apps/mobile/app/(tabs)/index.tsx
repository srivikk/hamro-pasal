import { router } from 'expo-router';
import { ActivityIndicator, SectionList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { VendorCard } from '../../src/components/VendorCard';
import { toFeedSections } from '../../src/features/feed/feed-sections';
import { useFeedQuery } from '../../src/features/feed/useFeedQuery';
import { useCustomerLocation } from '../../src/features/location/customer-location';

export default function FeedScreen() {
  const { t } = useTranslation();
  // The saved delivery address's pin (Thamel until one is saved); live GPS comes in a later phase.
  const feed = useFeedQuery(useCustomerLocation());

  if (feed.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50">
        <ActivityIndicator testID="feed-loading" />
      </View>
    );
  }

  if (feed.isError) {
    return (
      <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
        <Text className="text-center text-base text-neutral-700">{t('feed.loadError')}</Text>
        <Button label={t('common.retry')} onPress={() => void feed.refetch()} />
      </View>
    );
  }

  return (
    <SectionList
      className="flex-1 bg-neutral-50"
      contentContainerClassName="pb-6"
      sections={toFeedSections(feed.data)}
      keyExtractor={(entry) => entry.vendor.id}
      stickySectionHeadersEnabled={false}
      refreshing={feed.isRefetching}
      onRefresh={() => void feed.refetch()}
      renderSectionHeader={({ section }) =>
        section.key === 'serviceable' ? (
          <View className="px-4 pb-2 pt-4">
            <Text className="text-lg font-bold text-neutral-900">
              {t('feed.serviceableHeading')}
            </Text>
            {section.data.length === 0 ? (
              <Text className="mt-1 text-sm text-neutral-600">{t('feed.empty')}</Text>
            ) : null}
          </View>
        ) : (
          <View className="px-4 pb-2 pt-6" testID="explore-further-header">
            <Text className="text-lg font-bold text-neutral-500">
              {t('feed.exploreFurtherHeading')}
            </Text>
            <Text className="mt-1 text-sm text-neutral-500">{t('feed.exploreFurtherHint')}</Text>
          </View>
        )
      }
      renderItem={({ item }) => (
        <VendorCard
          entry={item}
          onPress={(vendorId) => {
            router.push({ pathname: '/vendor/[id]', params: { id: vendorId } });
          }}
        />
      )}
    />
  );
}

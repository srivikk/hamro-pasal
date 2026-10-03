import { router } from 'expo-router';
import { ActivityIndicator, SectionList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError, CLIENT_ERROR_CODES } from '../../api/http';
import { Button } from '../../components/Button';
import { VendorCard } from '../../components/VendorCard';
import { toFeedSections } from './feed-sections';
import type { useFeedQuery } from './useFeedQuery';

/** The vendor feed (GET /api/vendors): shops that deliver here, then "Explore Further". */
export function ShopsFeed({ feed }: { feed: ReturnType<typeof useFeedQuery> }) {
  const { t } = useTranslation();

  if (feed.isPending) {
    return (
      <View className="flex-1 items-center justify-center bg-neutral-50">
        <ActivityIndicator testID="feed-loading" />
      </View>
    );
  }

  if (feed.isError) {
    // No session (never signed in, or the 15-min access token has lapsed): offer sign-in, which
    // returns here afterwards.
    const needsSignIn =
      feed.error instanceof ApiError &&
      (feed.error.code === CLIENT_ERROR_CODES.notSignedIn || feed.error.status === 401);
    if (needsSignIn) {
      return (
        <View className="flex-1 items-center justify-center gap-4 bg-neutral-50 px-6">
          <Text className="text-center text-base text-neutral-700">{t('feed.signInPrompt')}</Text>
          <Button
            label={t('auth.title')}
            onPress={() => {
              router.push('/login');
            }}
          />
        </View>
      );
    }
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

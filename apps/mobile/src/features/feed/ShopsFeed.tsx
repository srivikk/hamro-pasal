import type { FeedEntry } from '@hamro-pasal/shared-types';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { ScrollView, SectionList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { FeedSkeleton } from '../../components/Skeleton';
import { VendorCard } from '../../components/VendorCard';
import { filterFeedByVendors } from '../discovery/category-shops';
import { vendorExtras } from '../promo/mock-promotions';
import { feedEmptyState } from './empty-states';
import { toFeedSections, type FeedSection } from './feed-sections';
import { DEFAULT_FEED_SORT, sortFeed, type FeedSort } from './feed-sort';
import type { useFeedQuery } from './useFeedQuery';

/** The vendor feed (GET /api/vendors): shops that deliver here, then "Explore Further". */
export function ShopsFeed({
  feed,
  onlyVendorIds = null,
  sort = DEFAULT_FEED_SORT,
  header = null,
  scrollToShops = false,
  onScrolledToShops,
  onRefresh,
}: {
  feed: ReturnType<typeof useFeedQuery>;
  /** A category or an offer label is chosen: only these shops are listed. Null lists every shop. */
  onlyVendorIds?: readonly string[] | null;
  /** The order inside each section; Relevance keeps the server's (nearest first). */
  sort?: FeedSort;
  /** What scrolls away above the shops (banners, offers, categories, the filter button). */
  header?: ReactNode;
  /**
   * A request to bring the first shop to the top of the screen (a promotion just filtered the
   * list). Answered once the list and its header are laid out, then `onScrolledToShops` is called.
   */
  scrollToShops?: boolean;
  onScrolledToShops?: () => void;
  /** Pull to refresh; refetches the feed when not given. Home also refreshes its categories. */
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  const list = useRef<SectionList<FeedEntry, FeedSection>>(null);
  // How tall the header is: scrolling by exactly that puts "Delivers to you" at the top.
  const headerHeight = useRef<number | null>(null);
  const listed = feed.isSuccess;

  const goToShops = useCallback(
    (offset: number) => {
      list.current?.getScrollResponder()?.scrollTo({ y: offset, animated: true });
      onScrolledToShops?.();
    },
    [onScrolledToShops],
  );
  // The list was already on screen when the request came. A list that has just been mounted has
  // no measured header yet: its onLayout below answers the request instead.
  useEffect(() => {
    if (scrollToShops && listed && headerHeight.current !== null) goToShops(headerHeight.current);
  }, [scrollToShops, listed, goToShops]);

  if (feed.isPending) {
    return (
      // The shape of what is coming (a heading and shop cards) instead of a spinner.
      <ScrollView className="flex-1 bg-gray-50" scrollEnabled={false}>
        {header}
        <FeedSkeleton testID="feed-loading" />
      </ScrollView>
    );
  }

  // The feed is public: a guest sees the same shops. Sign-in is asked for at checkout only.
  if (feed.isError) {
    return (
      <View className="flex-1 bg-gray-50">
        {header}
        <View className="flex-1 items-center justify-center gap-4 px-6">
          <Text className="text-center text-base text-gray-700">{t('feed.loadError')}</Text>
          <Button label={t('common.retry')} onPress={() => void feed.refetch()} />
        </View>
      </View>
    );
  }

  return (
    <SectionList
      ref={list}
      className="flex-1 bg-gray-50"
      contentContainerClassName="pb-6"
      sections={toFeedSections(
        sortFeed(filterFeedByVendors(feed.data, onlyVendorIds), sort, vendorExtras),
      )}
      keyExtractor={(entry) => entry.vendor.id}
      stickySectionHeadersEnabled={false}
      refreshing={feed.isRefetching}
      onRefresh={onRefresh ?? (() => void feed.refetch())}
      ListHeaderComponent={
        <View
          testID="feed-header"
          onLayout={({ nativeEvent }) => {
            headerHeight.current = nativeEvent.layout.height;
            if (scrollToShops) goToShops(nativeEvent.layout.height);
          }}
        >
          {header}
        </View>
      }
      renderSectionHeader={({ section }) =>
        section.key === 'serviceable' ? (
          <View className="px-4 pb-2 pt-4">
            <Text className="text-lg font-bold text-gray-900">{t('feed.serviceableHeading')}</Text>
            {section.data.length === 0 ? (
              // No shop live anywhere yet reads as onboarding, not as a problem with the address.
              feedEmptyState(feed.data) === 'ONBOARDING' ? (
                <Text className="mt-1 text-sm text-gray-500" testID="feed-onboarding">
                  {t('feed.onboarding')}
                </Text>
              ) : (
                <Text className="mt-1 text-sm text-gray-500" testID="feed-empty">
                  {t('feed.empty')}
                </Text>
              )
            ) : null}
          </View>
        ) : (
          <View className="px-4 pb-2 pt-6" testID="explore-further-header">
            <Text className="text-lg font-bold text-gray-500">
              {t('feed.exploreFurtherHeading')}
            </Text>
            <Text className="mt-1 text-sm text-gray-500">{t('feed.exploreFurtherHint')}</Text>
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

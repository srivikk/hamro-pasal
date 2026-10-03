import { MAX_PRODUCT_SEARCH_LENGTH } from '@hamro-pasal/shared-types';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CategoryPills } from '../../src/features/discovery/CategoryPills';
import { rootCategories } from '../../src/features/discovery/discovery-rules';
import { ProductResults } from '../../src/features/discovery/ProductResults';
import { useCategoriesQuery } from '../../src/features/discovery/useCategoriesQuery';
import { useProductSearch } from '../../src/features/discovery/useProductSearch';
import { ShopsFeed } from '../../src/features/feed/ShopsFeed';
import { useFeedQuery } from '../../src/features/feed/useFeedQuery';
import { useCustomerLocation } from '../../src/features/location/customer-location';

/**
 * Home: the vendor feed, plus product discovery (Phase 18). Typing in the search field or choosing
 * a category pill swaps the feed for the public product list; clearing both brings the shops back.
 */
export default function FeedScreen() {
  const { t } = useTranslation();
  // The saved delivery address's pin (Thamel until one is saved); live GPS comes in a later phase.
  const feed = useFeedQuery(useCustomerLocation());
  const categories = useCategoriesQuery();
  const [searchInput, setSearchInput] = useState('');
  const [chosenCategoryId, setChosenCategoryId] = useState<string | null>(null);

  const roots = rootCategories(categories.data?.categories ?? []);
  // A category that left the taxonomy (hidden by an admin) stops filtering as soon as it is gone.
  const categoryId = roots.some((category) => category.id === chosenCategoryId)
    ? chosenCategoryId
    : null;
  const search = useProductSearch(searchInput, categoryId);

  return (
    <View className="flex-1 bg-neutral-50">
      <View className="px-4 pb-3 pt-3">
        <TextInput
          testID="product-search"
          value={searchInput}
          onChangeText={setSearchInput}
          placeholder={t('discovery.searchPlaceholder')}
          accessibilityLabel={t('discovery.searchPlaceholder')}
          maxLength={MAX_PRODUCT_SEARCH_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          className="rounded-xl border border-neutral-300 bg-white px-3 py-3 text-base text-neutral-900"
        />
      </View>
      {/* Without the taxonomy (still loading, or the request failed) search alone still works. */}
      {roots.length === 0 ? null : (
        <CategoryPills categories={roots} selectedId={categoryId} onSelect={setChosenCategoryId} />
      )}
      {search.active ? (
        <ProductResults search={search} feed={feed.data} />
      ) : (
        <ShopsFeed feed={feed} />
      )}
    </View>
  );
}

import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { colors } from '../../theme/colors';
import { DEFAULT_FEED_SORT, FEED_SORTS, type FeedSort } from './feed-sort';

/**
 * The "Filter" button above the shop list, with the chosen order beside it while one is active
 * (tapping that chip goes back to Relevance), and the offer label a promotion filtered by.
 */
export function FeedFilterBar({
  sort,
  onOpen,
  onClear,
  discountTag = null,
  onClearTag,
}: {
  sort: FeedSort;
  onOpen: () => void;
  onClear: () => void;
  /** The offer label the shops are filtered by (from a DISCOUNT_TAG promotion), if any. */
  discountTag?: string | null;
  onClearTag?: () => void;
}) {
  const { t } = useTranslation();
  const sorted = sort !== DEFAULT_FEED_SORT;
  return (
    <View className="flex-row flex-wrap items-center gap-2 px-4 pb-1 pt-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('feedSort.filter')}
        testID="feed-filter-button"
        className={`flex-row items-center gap-1.5 rounded-full border bg-white px-3 py-2 shadow-sm active:bg-gray-100 ${
          sorted ? 'border-brand' : 'border-transparent'
        }`}
        onPress={onOpen}
      >
        <Ionicons name="options-outline" size={16} color={colors.brand} />
        <Text className="text-sm font-semibold text-gray-900">{t('feedSort.filter')}</Text>
      </Pressable>
      {sorted ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('feedSort.remove', { sort: t(`feedSort.options.${sort}`) })}
          testID="feed-sort-chip"
          className="flex-row items-center gap-1 rounded-full bg-brand-light px-3 py-2 active:opacity-70"
          onPress={onClear}
        >
          <Text className="text-sm font-semibold text-brand">{t(`feedSort.options.${sort}`)}</Text>
          <Ionicons name="close" size={14} color={colors.brand} />
        </Pressable>
      ) : null}
      {discountTag === null ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('promo.removeTag', { tag: discountTag })}
          testID="feed-tag-chip"
          className="flex-row items-center gap-1 rounded-full bg-green-100 px-3 py-2 active:opacity-70"
          onPress={onClearTag}
        >
          <Ionicons name="pricetag" size={12} color={colors.success} />
          <Text className="text-sm font-semibold text-green-800">{discountTag}</Text>
          <Ionicons name="close" size={14} color={colors.success} />
        </Pressable>
      )}
    </View>
  );
}

/** The radio list. Mounted only while the sheet is open, so each opening starts from `sort`. */
function SheetBody({ sort, onApply }: { sort: FeedSort; onApply: (sort: FeedSort) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<FeedSort>(sort);
  return (
    <View className="rounded-t-3xl bg-white px-5 pb-8 pt-3" testID="sort-sheet">
      <View className="mb-3 h-1 w-10 self-center rounded-full bg-gray-300" />
      <Text className="text-lg font-extrabold text-gray-900">{t('feedSort.title')}</Text>
      <Text className="pb-1 pt-4 text-xs font-bold uppercase tracking-wide text-gray-500">
        {t('feedSort.sortBy')}
      </Text>
      <View accessibilityRole="radiogroup">
        {FEED_SORTS.map((option) => {
          const checked = option === draft;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={t(`feedSort.options.${option}`)}
              accessibilityState={{ checked }}
              testID={`sort-option-${option}`}
              className="flex-row items-center justify-between py-3 active:opacity-70"
              onPress={() => {
                setDraft(option);
              }}
            >
              <Text
                className={`text-base ${checked ? 'font-bold text-gray-900' : 'text-gray-700'}`}
              >
                {t(`feedSort.options.${option}`)}
              </Text>
              <View
                className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
                  checked ? 'border-brand' : 'border-gray-300'
                }`}
              >
                {checked ? <View className="h-2.5 w-2.5 rounded-full bg-brand" /> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      <View className="mt-4 flex-row gap-3">
        <View className="flex-1">
          <Button
            label={t('feedSort.clear')}
            variant="secondary"
            testID="sort-clear"
            onPress={() => {
              onApply(DEFAULT_FEED_SORT);
            }}
          />
        </View>
        <View className="flex-1">
          <Button
            label={t('feedSort.apply')}
            testID="sort-apply"
            onPress={() => {
              onApply(draft);
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * "Sort & filter" as a bottom sheet. A choice takes effect only with Apply; "Clear filters" goes
 * back to Relevance and closes; the backdrop closes without changing anything.
 */
export function SortFilterSheet({
  visible,
  sort,
  onApply,
  onClose,
}: {
  visible: boolean;
  sort: FeedSort;
  onApply: (sort: FeedSort) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel={t('feedSort.close')}
        testID="sort-sheet-backdrop"
        className="flex-1 bg-black/50"
        onPress={onClose}
      />
      {visible ? <SheetBody sort={sort} onApply={onApply} /> : null}
    </Modal>
  );
}

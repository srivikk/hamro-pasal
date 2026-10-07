import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ratingCountDisplay } from '../features/promo/promo-model';
import { formatLocalizedNumber } from '../i18n/format-number';

/** The green "★ 4.3" pill. `prominent` is the larger one on the shop page. */
export function RatingPill({
  rating,
  prominent = false,
  testID,
}: {
  /** 1–5; shown with one decimal. */
  rating: number;
  prominent?: boolean;
  testID?: string;
}) {
  const { t, i18n } = useTranslation();
  const value = formatLocalizedNumber(
    Math.round(rating * 10) / 10,
    i18n.language === 'ne' ? 'ne' : 'en',
  );
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={t('vendor.ratingLabel', { rating: value })}
      className={`flex-row items-center gap-1 rounded-lg bg-green-700 ${
        prominent ? 'px-2.5 py-1.5' : 'px-1.5 py-0.5'
      }`}
    >
      <Ionicons name="star" size={prominent ? 14 : 10} color="#FFFFFF" />
      <Text className={`font-bold text-white ${prominent ? 'text-base' : 'text-xs'}`}>{value}</Text>
    </View>
  );
}

/**
 * "★ 4.1 (200+)": the pill with the number of ratings beside it in small grey type. The count is
 * rounded down with a plus above ten; without a count the pill stands alone.
 */
export function RatingSummary({
  rating,
  count,
  testID,
}: {
  rating: number;
  count: number | null;
  /** The pill gets this id, the count `<testID>-count`. */
  testID: string;
}) {
  const { t } = useTranslation();
  const shown = count === null ? null : ratingCountDisplay(count);
  return (
    <View className="flex-row items-center gap-1">
      <RatingPill rating={rating} testID={testID} />
      {shown === null ? null : (
        <Text className="text-[11px] font-medium text-gray-500" testID={`${testID}-count`}>
          {shown.plus
            ? t('vendor.ratingCountShortPlus', { count: shown.shown })
            : t('vendor.ratingCountShort', { count: shown.shown })}
        </Text>
      )}
    </View>
  );
}

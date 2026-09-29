import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { FeedEntry } from '../features/feed/feed-contract';

export interface VendorCardProps {
  entry: FeedEntry;
  /** Ignored for unserviceable vendors: their carts are disabled (SPEC customer flow step 3). */
  onPress?: (vendorId: string) => void;
}

/** One decimal place is enough for "x km away" and keeps Devanagari output short. */
function roundKm(km: number): number {
  return Math.round(km * 10) / 10;
}

export function VendorCard({ entry, onPress }: VendorCardProps) {
  const { t } = useTranslation();
  const { vendor, serviceable } = entry;
  const interactive = serviceable && onPress !== undefined;

  const scopeLabel =
    vendor.delivery_scope === 'RADIUS_BOUND'
      ? t('vendor.scope.RADIUS_BOUND', { radius: vendor.radius_km })
      : vendor.delivery_scope === 'CITY_WIDE'
        ? t('vendor.scope.CITY_WIDE', { palika: vendor.municipality_palika_string })
        : t('vendor.scope.NATION_WIDE');

  // Desaturated palette for Explore Further: grey text, grey surface, reduced opacity.
  const muted = !serviceable;

  return (
    <Pressable
      testID={`vendor-card-${vendor.id}`}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityState={{ disabled: !interactive }}
      disabled={!interactive}
      onPress={() => {
        if (interactive) onPress(vendor.id);
      }}
      className={`mx-4 mb-3 rounded-2xl border p-4 ${
        muted
          ? 'border-neutral-200 bg-neutral-100 opacity-60'
          : 'border-neutral-200 bg-white active:bg-neutral-50'
      }`}
    >
      <View className="flex-row items-start justify-between">
        <Text
          className={`flex-1 text-lg font-bold ${muted ? 'text-neutral-500' : 'text-neutral-900'}`}
          numberOfLines={1}
        >
          {vendor.business_name}
        </Text>
        <Text className={`ml-2 text-sm ${muted ? 'text-neutral-400' : 'text-neutral-600'}`}>
          {t('vendor.distance', { distance: roundKm(entry.distance_km) })}
        </Text>
      </View>

      <Text className={`mt-1 text-sm ${muted ? 'text-neutral-400' : 'text-brand'}`}>
        {scopeLabel}
      </Text>

      <View className="mt-2 flex-row gap-3">
        <Text className={`text-sm ${muted ? 'text-neutral-400' : 'text-neutral-700'}`}>
          {t('vendor.deliveryFee', { amount: vendor.base_delivery_fee_npr })}
        </Text>
        <Text className={`text-sm ${muted ? 'text-neutral-400' : 'text-neutral-700'}`}>
          {t('vendor.minOrder', { amount: vendor.min_order_value })}
        </Text>
      </View>

      {muted ? (
        <View className="mt-3 self-start rounded-full bg-neutral-200 px-3 py-1">
          <Text className="text-xs font-semibold text-neutral-500">{t('vendor.unavailable')}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

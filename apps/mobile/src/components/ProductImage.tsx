import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { colors } from '../theme/colors';

/**
 * A product's photo. Without one, or when it fails to load, a clean grey tile with a shop icon
 * stands in (never a broken image). A sold-out product gets a dark "OUT OF STOCK" veil over
 * whichever of the two is shown.
 */
export function ProductImage({
  uri,
  soldOut,
  className,
  compact = false,
  onPress,
  pressLabel,
  pressTestID,
  imageTestID,
  placeholderTestID,
}: {
  uri: string | null | undefined;
  soldOut: boolean;
  /** Size and corners of the tile ("h-16 w-16 rounded-xl"). */
  className: string;
  /** A thumbnail: smaller icon and veil text. */
  compact?: boolean;
  /** Only a photo that is showing can be pressed (to open it full screen). */
  onPress?: () => void;
  pressLabel?: string;
  pressTestID?: string;
  imageTestID?: string;
  placeholderTestID?: string;
}) {
  const { t } = useTranslation();
  // The address that failed, not a flag: a product whose photo changes gets a fresh attempt.
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const shown = uri != null && uri !== '' && uri !== failedUri ? uri : null;

  const veil = soldOut ? (
    <View
      pointerEvents="none"
      testID="out-of-stock-overlay"
      className="absolute inset-0 flex items-center justify-center bg-black/40"
    >
      <Text
        className={`text-center font-bold text-white ${
          compact ? 'text-[9px] leading-3' : 'text-lg tracking-widest'
        }`}
      >
        {t('menu.outOfStockOverlay')}
      </Text>
    </View>
  ) : null;

  if (shown === null) {
    return (
      <View
        testID={placeholderTestID}
        className={`items-center justify-center overflow-hidden bg-gray-100 ${className}`}
      >
        <Ionicons name="storefront-outline" size={compact ? 26 : 56} color={colors.inactive} />
        {veil}
      </View>
    );
  }

  const photo = (
    <Image
      source={{ uri: shown }}
      className="h-full w-full"
      resizeMode="cover"
      testID={imageTestID}
      onError={() => {
        setFailedUri(shown);
      }}
    />
  );
  if (onPress === undefined) {
    return (
      <View className={`overflow-hidden bg-gray-100 ${className}`}>
        {photo}
        {veil}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={pressLabel}
      testID={pressTestID}
      className={`overflow-hidden bg-gray-100 active:opacity-70 ${className}`}
      onPress={onPress}
    >
      {photo}
      {veil}
    </Pressable>
  );
}

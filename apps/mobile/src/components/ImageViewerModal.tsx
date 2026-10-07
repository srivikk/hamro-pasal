import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Image, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatLocalizedNumber } from '../i18n/format-number';

/**
 * A full-screen photo viewer: the images on black, swiped sideways when there are several, with
 * a close button. Plain Modal and ScrollView, no gallery library. Open while `images` is not null.
 */
export function ImageViewerModal({
  images,
  title,
  onClose,
}: {
  images: readonly string[] | null;
  /** What the photos show (the product's name), for screen readers. */
  title: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { width, height } = useWindowDimensions();
  const { top } = useSafeAreaInsets();
  const [page, setPage] = useState(0);
  const count = images?.length ?? 0;
  const locale = i18n.language === 'ne' ? 'ne' : 'en';

  return (
    <Modal
      visible={images !== null}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
      onShow={() => {
        setPage(0);
      }}
    >
      <View className="flex-1 bg-black" testID="image-viewer">
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={({ nativeEvent }) => {
            setPage(Math.round(nativeEvent.contentOffset.x / width));
          }}
        >
          {(images ?? []).map((uri, index) => (
            <Image
              key={uri}
              source={{ uri }}
              accessibilityLabel={t('menu.photoOf', { name: title })}
              testID={`image-viewer-photo-${String(index)}`}
              style={{ width, height }}
              resizeMode="contain"
            />
          ))}
        </ScrollView>
        {count > 1 ? (
          <Text
            className="absolute bottom-10 self-center rounded-full bg-white/20 px-3 py-1 text-sm font-semibold text-white"
            testID="image-viewer-count"
          >
            {`${formatLocalizedNumber(Math.min(page, count - 1) + 1, locale)} / ${formatLocalizedNumber(count, locale)}`}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('menu.closePhoto')}
          testID="image-viewer-close"
          hitSlop={12}
          style={{ top: top + 12 }}
          className="absolute right-4 h-10 w-10 items-center justify-center rounded-full bg-white/20 active:bg-white/40"
          onPress={onClose}
        >
          <Ionicons name="close" size={22} color="#FFFFFF" />
        </Pressable>
      </View>
    </Modal>
  );
}

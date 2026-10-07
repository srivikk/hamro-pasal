import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCartStore } from '../store/useCartStore';
import { useToastStore, type ToastTone } from '../store/useToastStore';

export const TOAST_DURATION_MS = 4000;
/** Above the tab bar; with items in the cart, also above the cart banner (or the cart's own bar). */
const BASE_OFFSET = 72;
const CART_BAR_HEIGHT = 56;

const toneClass: Record<ToastTone, string> = {
  success: 'bg-emerald-700',
  error: 'bg-red-700',
  info: 'bg-gray-800',
};

/**
 * The app's one notification surface: non-blocking, anchored to the bottom, fading in and out by
 * itself. Mounted once at the root. Shows the latest toast for 4 s; tap to dismiss early.
 */
export function ToastHost() {
  const toast = useToastStore((state) => state.toast);
  const dismiss = useToastStore((state) => state.dismiss);
  const insets = useSafeAreaInsets();
  const cartBarShown = useCartStore((state) => state.lines.length > 0);

  useEffect(() => {
    if (toast === null) return undefined;
    const timer = setTimeout(() => {
      dismiss(toast.id);
    }, TOAST_DURATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast, dismiss]);

  if (toast === null) return null;
  return (
    <Animated.View
      key={toast.id}
      entering={FadeInDown}
      exiting={FadeOutDown}
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: insets.bottom + BASE_OFFSET + (cartBarShown ? CART_BAR_HEIGHT : 0),
      }}
    >
      <Pressable
        accessibilityRole="alert"
        testID="toast"
        onPress={() => {
          dismiss(toast.id);
        }}
        className={`rounded-xl px-4 py-3 ${toneClass[toast.tone]}`}
      >
        <Text className="text-sm font-semibold text-white">{toast.message}</Text>
      </Pressable>
    </Animated.View>
  );
}

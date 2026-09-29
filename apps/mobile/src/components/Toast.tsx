import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToastStore, type ToastTone } from '../store/useToastStore';

export const TOAST_DURATION_MS = 4000;

const toneClass: Record<ToastTone, string> = {
  success: 'bg-emerald-700',
  error: 'bg-red-700',
  info: 'bg-neutral-800',
};

/** Mounted once at the root. Shows the latest toast for 4 s; tap to dismiss early. */
export function ToastHost() {
  const toast = useToastStore((state) => state.toast);
  const dismiss = useToastStore((state) => state.dismiss);
  const insets = useSafeAreaInsets();

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
      style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 72 }}
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

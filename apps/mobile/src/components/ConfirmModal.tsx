import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';

import { colors } from '../theme/colors';
import { Button } from './Button';

/**
 * The app's own confirmation dialog (instead of the system alert): a white card over a dimmed
 * screen with an icon, a title, a message and two buttons. The backdrop and the Android back
 * button cancel. Texts arrive already translated.
 */
export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  icon = 'alert-circle',
  testID = 'confirm-modal',
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  icon?: ComponentProps<typeof Ionicons>['name'];
  testID?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View className="flex-1 items-center justify-center px-8">
        <Pressable
          accessibilityLabel={cancelLabel}
          testID={`${testID}-backdrop`}
          className="absolute bottom-0 left-0 right-0 top-0 bg-black/50"
          onPress={onCancel}
        />
        <View
          accessibilityRole="alert"
          testID={testID}
          className="w-full max-w-sm items-center rounded-3xl bg-white p-6 shadow-sm"
        >
          <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-light">
            <Ionicons name={icon} size={28} color={colors.brand} />
          </View>
          <Text className="mt-4 text-center text-lg font-extrabold text-gray-900">{title}</Text>
          <Text className="mt-2 text-center text-sm leading-5 text-gray-500">{message}</Text>
          <View className="mt-6 w-full flex-row gap-3">
            <View className="flex-1">
              <Button label={cancelLabel} variant="secondary" onPress={onCancel} />
            </View>
            <View className="flex-1">
              <Button label={confirmLabel} onPress={onConfirm} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

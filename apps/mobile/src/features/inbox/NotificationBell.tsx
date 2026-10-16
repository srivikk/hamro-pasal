import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { badgeText } from './inbox-api';
import { useUnreadCount } from './useInbox';

/**
 * Step 7.5 (SPEC core 11): the bell that opens the notification centre, with the unread count.
 * Shown only to a signed-in account (a guest has no notification centre).
 */
export function NotificationBell({ color, className = '' }: { color: string; className?: string }) {
  const { t } = useTranslation();
  const signedIn = useAuthStore(selectHasSession);
  const unread = useUnreadCount();
  if (!signedIn) return null;
  const badge = badgeText(unread.data ?? 0);

  return (
    <Pressable
      testID="notification-bell"
      accessibilityRole="button"
      accessibilityLabel={
        badge === null ? t('inbox.open') : t('inbox.openUnread', { count: unread.data ?? 0 })
      }
      hitSlop={8}
      className={className}
      onPress={() => {
        router.push('/notifications');
      }}
    >
      <Ionicons name="notifications-outline" size={22} color={color} />
      {badge === null ? null : (
        <View
          testID="notification-badge"
          className="absolute -right-1.5 -top-1 min-w-4 items-center rounded-full bg-red-600 px-1"
        >
          <Text className="text-[10px] font-bold text-white">{badge}</Text>
        </View>
      )}
    </Pressable>
  );
}

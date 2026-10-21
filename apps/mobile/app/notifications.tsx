import type { NotificationView } from '@hamro-pasal/shared-types';
import { router, Stack } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../src/components/Button';
import { badgeText, deepLinkOf } from '../src/features/inbox/inbox-api';
import { notificationRowStyle } from '../src/features/inbox/inbox-style';
import {
  useInbox,
  useMarkAllRead,
  useMarkRead,
  useUnreadCount,
} from '../src/features/inbox/useInbox';
import { colors } from '../src/theme/colors';

function Row({ notification, onPress }: { notification: NotificationView; onPress: () => void }) {
  const { t, i18n } = useTranslation();
  const unread = notification.read_at === null;
  const style = notificationRowStyle(unread);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: unread }}
      accessibilityHint={unread ? t('inbox.unreadHint') : undefined}
      testID={`notification-${notification.id}`}
      className={`mx-4 mb-2 flex-row gap-3 rounded-2xl p-4 active:opacity-70 ${style.row}`}
      onPress={onPress}
    >
      <View
        testID={unread ? `notification-unread-${notification.id}` : undefined}
        className={`mt-1.5 h-2.5 w-2.5 rounded-full ${style.dot}`}
      />
      <View className="flex-1">
        <Text
          testID={`notification-title-${notification.id}`}
          className={`text-base ${style.title}`}
        >
          {notification.title}
        </Text>
        <Text className={`mt-1 text-sm ${style.body}`}>{notification.body}</Text>
        <Text className={`mt-1 text-xs ${style.time}`}>
          {new Date(notification.created_at).toLocaleString(
            i18n.language === 'ne' ? 'ne-NP' : 'en-GB',
            { dateStyle: 'medium', timeStyle: 'short' },
          )}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Step 7.5 (SPEC core 11, customer and Seller app addition 3): every message kept for the
 * account, newest first. Since 2026-10-21 (Task 4) order alerts are kept here too, and the two
 * states are strict: unread on a dark background in bold with a dot, read on a light one
 * (`notificationRowStyle`); the unread count heads the list as a badge. Tapping one marks it read and opens its link when
 * the Super Admin gave one. The same screen serves both builds.
 */
export default function NotificationsScreen() {
  const { t } = useTranslation();
  const inbox = useInbox();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const unreadCount = useUnreadCount();
  const badge = badgeText(unreadCount.data ?? 0);
  const notifications = inbox.data?.pages.flatMap((page) => page.notifications) ?? [];
  const anyUnread = notifications.some((n) => n.read_at === null);

  const open = (notification: NotificationView) => {
    if (notification.read_at === null) markRead.mutate(notification.id);
    const link = deepLinkOf(notification);
    if (link !== null) router.push(link as never);
  };

  return (
    <View className="flex-1 bg-gray-50">
      <Stack.Screen
        options={{
          headerShown: true,
          title: t('inbox.title'),
          headerBackTitle: t('common.back'),
          headerRight: () =>
            anyUnread ? (
              <Pressable
                testID="notifications-read-all"
                accessibilityRole="button"
                hitSlop={8}
                disabled={markAll.isPending}
                onPress={() => {
                  markAll.mutate();
                }}
              >
                <Text className="text-sm font-semibold text-brand">{t('inbox.markAll')}</Text>
              </Pressable>
            ) : null,
        }}
      />
      {inbox.isPending ? (
        <ActivityIndicator className="mt-10" color={colors.brand} testID="notifications-loading" />
      ) : inbox.isError ? (
        <View className="items-center gap-3 px-8 pt-10" testID="notifications-failed">
          <Text className="text-center text-base text-gray-700">{t('inbox.failed')}</Text>
          <Button label={t('inbox.retry')} onPress={() => void inbox.refetch()} />
        </View>
      ) : (
        <FlatList
          testID="notifications-list"
          data={notifications}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingVertical: 12, flexGrow: 1 }}
          ListHeaderComponent={
            badge === null ? null : (
              <View className="mx-4 mb-3 flex-row items-center gap-2">
                <View
                  testID="notifications-unread-badge"
                  className="min-w-6 items-center rounded-full bg-brand px-2 py-0.5"
                >
                  <Text className="text-xs font-bold text-white">{badge}</Text>
                </View>
                <Text className="text-sm font-semibold text-ink dark:text-ink-dark">
                  {t('inbox.unreadCount', { count: unreadCount.data ?? 0 })}
                </Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <Row
              notification={item}
              onPress={() => {
                open(item);
              }}
            />
          )}
          ListEmptyComponent={
            <Text
              className="px-8 pt-10 text-center text-base text-gray-500"
              testID="notifications-empty"
            >
              {t('inbox.empty')}
            </Text>
          }
          onEndReached={() => {
            if (inbox.hasNextPage && !inbox.isFetchingNextPage) void inbox.fetchNextPage();
          }}
          ListFooterComponent={
            inbox.isFetchingNextPage ? <ActivityIndicator color={colors.brand} /> : null
          }
        />
      )}
    </View>
  );
}

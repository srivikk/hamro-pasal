import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { formatLocalizedNumber } from '../../src/i18n/format-number';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { useItemCount } from '../../src/store/useCartStore';
import { colors } from '../../src/theme/colors';

export default function TabsLayout() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const itemCount = useItemCount();
  const role = useAuthStore((state) => (selectHasSession(state) ? state.role : null));

  // A vendor or rider signing in (or relaunching) lands on their dashboard, not the customer shop.
  if (role === 'VENDOR') return <Redirect href="/dashboard" />;
  if (role === 'DRIVER') return <Redirect href="/driver/dashboard" />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.inactive,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('tabs.feed'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="storefront-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="cart"
        options={{
          title: t('tabs.cart'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cart-outline" color={color} size={size} />
          ),
          ...(itemCount > 0 ? { tabBarBadge: formatLocalizedNumber(itemCount, locale) } : {}),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('tabs.profile'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}

import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, router, Tabs } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { NotificationBell } from '../../src/features/inbox/NotificationBell';
import { isSellerApp } from '../../src/lib/app-variant';
import { VendorOnlineToggle } from '../../src/features/vendor/VendorOnlineToggle';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { colors } from '../../src/theme/colors';

/** A round icon button for the Vendor App header. */
function HeaderIcon({
  testID,
  icon,
  label,
  side,
  onPress,
}: {
  testID: string;
  icon: 'settings-outline' | 'receipt-outline' | 'stats-chart-outline' | 'arrow-back';
  label: string;
  side: 'left' | 'right';
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      className={side === 'left' ? 'ml-4' : 'mr-3'}
      onPress={onPress}
    >
      <Ionicons name={icon} size={24} color={colors.brand} />
    </Pressable>
  );
}

/**
 * Vendor-only routes. Anyone who is not a signed-in VENDOR (a customer, or a vendor who just signed
 * out) is sent to the customer app. The API enforces the role on every call; this only keeps the
 * screens apart.
 *
 * The Vendor App is four tabs: Live Orders (`/dashboard`, the landing screen), Catalogue, Ledger
 * (`/wallet`) and Marketing. Every header carries the shop's Online / Offline switch on the right
 * and the settings gear on the left. Invoices (`/invoices`, from the Ledger header), the
 * product form (`/product`, from the Catalogue) and Shop settings (`/settings`) are routes of the
 * navigator, so the tab bar stays, with no tab button.
 */
export default function VendorLayout() {
  const { t } = useTranslation();
  const isVendor = useAuthStore((state) => selectHasSession(state) && state.role === 'VENDOR');
  // Step 7.7: only the Seller app mounts the vendor screens.
  if (!isVendor || !isSellerApp()) return <Redirect href="/" />;

  return (
    <Tabs
      // Back from Settings or Invoices returns to the tab the vendor came from.
      backBehavior="history"
      screenOptions={{
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.inactive,
        headerLeft: () => (
          <HeaderIcon
            testID="vendor-settings-link"
            icon="settings-outline"
            label={t('vendorShop.openSettings')}
            side="left"
            onPress={() => {
              router.push('/settings');
            }}
          />
        ),
        // Step 7.5: the notification centre's bell beside the Online / Offline switch.
        headerRight: () => (
          <View className="flex-row items-center">
            <NotificationBell color={colors.brand} className="mr-4" />
            <VendorOnlineToggle />
          </View>
        ),
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          // The screens set their own header title; the tab keeps its short label.
          title: t('vendorTabs.orders'),
          tabBarLabel: t('vendorTabs.orders'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="notifications-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="catalogue"
        options={{
          title: t('vendorTabs.catalogue.title'),
          tabBarLabel: t('vendorTabs.catalogue.title'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="pricetags-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          title: t('vendorTabs.ledger'),
          tabBarLabel: t('vendorTabs.ledger'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet-outline" color={color} size={size} />
          ),
          headerRight: () => (
            <View className="flex-row items-center">
              <HeaderIcon
                testID="vendor-analytics-link"
                icon="stats-chart-outline"
                label={t('vendorAnalytics.title')}
                side="right"
                onPress={() => {
                  router.push('/analytics');
                }}
              />
              <HeaderIcon
                testID="vendor-invoices-link"
                icon="receipt-outline"
                label={t('vendorTabs.openInvoices')}
                side="right"
                onPress={() => {
                  router.push('/invoices');
                }}
              />
              <VendorOnlineToggle />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="marketing"
        options={{
          title: t('vendorTabs.marketing.title'),
          tabBarLabel: t('vendorTabs.marketing.title'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="megaphone-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="invoices"
        options={{
          href: null,
          title: t('vendorTabs.invoices'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-invoices-back"
              icon="arrow-back"
              label={t('vendorTabs.backToLedger')}
              side="left"
              onPress={() => {
                router.navigate('/wallet');
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="product"
        options={{
          href: null,
          title: t('vendorTabs.catalogue.title'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-product-back"
              icon="arrow-back"
              label={t('common.back')}
              side="left"
              onPress={() => {
                router.navigate('/catalogue');
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="offer"
        options={{
          href: null,
          title: t('vendorTabs.marketing.title'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-offer-back"
              icon="arrow-back"
              label={t('common.back')}
              side="left"
              onPress={() => {
                router.navigate('/marketing');
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="analytics"
        options={{
          href: null,
          title: t('vendorAnalytics.title'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-analytics-back"
              icon="arrow-back"
              label={t('vendorTabs.backToLedger')}
              side="left"
              onPress={() => {
                router.navigate('/wallet');
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="order-chat"
        options={{
          href: null,
          title: t('dispute.title'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-order-chat-back"
              icon="arrow-back"
              label={t('common.back')}
              side="left"
              onPress={() => {
                router.back();
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="payments"
        options={{
          href: null,
          title: t('vendorShop.paymentsTitle'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-payments-back"
              icon="arrow-back"
              label={t('common.back')}
              side="left"
              onPress={() => {
                router.back();
              }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          href: null,
          title: t('vendorShop.settingsTitle'),
          headerLeft: () => (
            <HeaderIcon
              testID="vendor-settings-back"
              icon="arrow-back"
              label={t('common.back')}
              side="left"
              onPress={() => {
                router.back();
              }}
            />
          ),
        }}
      />
    </Tabs>
  );
}

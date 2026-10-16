import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { openSellerSignup } from '../../src/features/seller/become-seller';

import { useSignOut } from '../../src/api/auth';
import { Button } from '../../src/components/Button';
import { MenuCard, MenuRow, SectionTitle } from '../../src/components/MenuRow';
import { AddressBookModal } from '../../src/features/address/AddressBookModal';
import { DevSignIn } from '../../src/features/auth/DevSignIn';
import { formatNepalPhone } from '../../src/features/auth/login-form';
import { RiderModeEntry } from '../../src/features/driver/RiderModeEntry';
import { useCurrentPhone, useCurrentProfile } from '../../src/features/profile/profile-form';
import { APP_VERSION } from '../../src/features/settings/app-version';
import { useSetLanguage } from '../../src/features/settings/LanguageToggle';
import { TerritorySimulatorControls } from '../../src/features/territory/TerritoryGate';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { useThemeStore } from '../../src/store/useThemeStore';
import { colors } from '../../src/theme/colors';

/**
 * The Profile tab: the account header, then grouped menus. A guest sees the sign-in buttons and
 * the device settings only (Appearance, language, About); everything tied to an account
 * (orders, addresses, favourites, notification preferences, account privacy) needs a session.
 */
export default function ProfileScreen() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const setLanguage = useSetLanguage();
  const signedIn = useAuthStore(selectHasSession);
  const theme = useThemeStore((state) => state.theme);
  const signOut = useSignOut();
  const profile = useCurrentProfile();
  const phone = useCurrentPhone();
  const [addressBookOpen, setAddressBookOpen] = useState(false);

  const formattedPhone = phone === null ? null : formatNepalPhone(phone);
  // The name once it is known, else the number the account signed in with.
  const title = profile?.full_name ?? formattedPhone ?? t('account.yourAccount');
  const subtitle = [profile === null ? null : formattedPhone, profile?.email ?? null]
    .filter((line): line is string => line !== null)
    .join(' · ');

  return (
    <ScrollView
      className="flex-1 bg-gray-50 dark:bg-gray-950"
      contentContainerStyle={{ padding: 16, gap: 20 }}
      testID="profile-scroll"
    >
      <View
        className="flex-row items-center gap-4 rounded-2xl bg-white p-4 shadow-sm dark:bg-gray-900"
        testID="account-section"
      >
        <View className="h-14 w-14 items-center justify-center rounded-full bg-brand-light">
          <Ionicons name="person" size={26} color={colors.brand} />
        </View>
        {signedIn ? (
          <View className="flex-1" testID="profile-details">
            <Text className="text-xl font-bold text-gray-900 dark:text-gray-100" numberOfLines={1}>
              {title}
            </Text>
            {subtitle === '' ? null : (
              <Text className="mt-0.5 text-sm text-gray-500 dark:text-gray-400" numberOfLines={1}>
                {subtitle}
              </Text>
            )}
            {profile === null ? (
              <Text className="mt-1 text-sm text-amber-800 dark:text-amber-400">
                {t('profile.incomplete')}
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="flex-1">
            <Text className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {t('account.guestTitle')}
            </Text>
            <Text className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
              {t('auth.signedOutStatus')}
            </Text>
          </View>
        )}
      </View>

      {signedIn ? (
        <View className="gap-2">
          <SectionTitle>{t('account.section')}</SectionTitle>
          <MenuCard>
            <MenuRow
              icon="receipt-outline"
              label={t('account.orders')}
              testID="menu-orders"
              onPress={() => {
                router.push('/orders');
              }}
            />
            {/* Saved shops belong to an account: a guest has no Favourites row (and no hearts). */}
            <MenuRow
              icon="heart-outline"
              label={t('favourites.title')}
              testID="menu-favourites"
              onPress={() => {
                router.push('/favourites');
              }}
            />
            <MenuRow
              icon="location-outline"
              label={t('account.addressBook')}
              testID="menu-address-book"
              onPress={() => {
                setAddressBookOpen(true);
              }}
            />
            <MenuRow
              icon="person-outline"
              label={profile === null ? t('cart.completeProfile') : t('profile.edit')}
              testID="edit-profile"
              last
              onPress={() => {
                router.push('/complete-profile');
              }}
            />
          </MenuCard>
        </View>
      ) : (
        <View className="gap-3">
          <Button
            label={t('auth.title')}
            onPress={() => {
              router.push('/login');
            }}
          />
          {/* Registration is the same +977 OTP flow (SPEC: no passwords): an unknown number
              becomes a new customer account when its code is verified. */}
          <Button
            label={t('auth.createAccount')}
            variant="secondary"
            testID="create-account"
            onPress={() => {
              router.push({ pathname: '/login', params: { mode: 'signup' } });
            }}
          />
        </View>
      )}

      <View className="gap-2">
        <SectionTitle>{t('account.preferences')}</SectionTitle>
        <MenuCard>
          <MenuRow
            icon="color-palette-outline"
            label={t('appearance.title')}
            value={t(`appearance.short.${theme}`)}
            testID="menu-appearance"
            last={!signedIn}
            onPress={() => {
              router.push('/settings/appearance');
            }}
          />
          {signedIn ? (
            <MenuRow
              icon="notifications-outline"
              label={t('notificationPrefs.title')}
              testID="menu-notifications"
              last
              onPress={() => {
                router.push('/settings/notifications');
              }}
            />
          ) : null}
        </MenuCard>
      </View>

      <View className="gap-2">
        <SectionTitle>{t('settings.language')}</SectionTitle>
        <View className="flex-row gap-3 rounded-2xl bg-white p-3 shadow-sm dark:bg-gray-900">
          <View className="flex-1">
            <Button
              label={t('settings.english')}
              size="sm"
              variant={locale === 'en' ? 'primary' : 'secondary'}
              onPress={() => {
                setLanguage('en');
              }}
            />
          </View>
          <View className="flex-1">
            <Button
              label={t('settings.nepali')}
              size="sm"
              variant={locale === 'ne' ? 'primary' : 'secondary'}
              onPress={() => {
                setLanguage('ne');
              }}
            />
          </View>
        </View>
      </View>

      <View className="gap-2">
        <SectionTitle>{t('account.more')}</SectionTitle>
        <MenuCard>
          {/* Step 7.7: the Seller app's signup (or its store page). */}
          <MenuRow
            icon="storefront-outline"
            label={t('becomeSeller.title')}
            testID="menu-become-seller"
            onPress={() => {
              void openSellerSignup();
            }}
          />
          <MenuRow
            icon="information-circle-outline"
            label={t('about.title')}
            testID="menu-about"
            last={!signedIn}
            onPress={() => {
              router.push('/settings/about');
            }}
          />
          {signedIn ? (
            <>
              <MenuRow
                icon="lock-closed-outline"
                label={t('accountPrivacy.title')}
                testID="menu-account-privacy"
                onPress={() => {
                  router.push('/settings/privacy');
                }}
              />
              <MenuRow
                icon="log-out-outline"
                label={t('account.logOut')}
                testID="menu-log-out"
                danger
                last
                onPress={signOut}
              />
            </>
          ) : null}
        </MenuCard>
      </View>

      {__DEV__ ? <DevSignIn /> : null}
      {__DEV__ ? <RiderModeEntry /> : null}
      {__DEV__ ? <TerritorySimulatorControls /> : null}

      <Text
        className="pb-2 pt-1 text-center text-xs text-gray-400 dark:text-gray-500"
        testID="app-footer"
      >
        {t('account.footer', { version: APP_VERSION })}
      </Text>

      <AddressBookModal
        visible={addressBookOpen}
        onClose={() => {
          setAddressBookOpen(false);
        }}
      />
    </ScrollView>
  );
}

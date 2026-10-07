import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { tabResetAction, type TabsNavigation } from '../../src/features/navigation/tab-reset';
import { useOnboardingRequired } from '../../src/features/profile/profile-form';
import { selectHasSession, useAuthStore } from '../../src/store/useAuthStore';
import { useOnboardingStore } from '../../src/store/useOnboardingStore';
import { colors } from '../../src/theme/colors';

export default function TabsLayout() {
  const { t } = useTranslation();
  const role = useAuthStore((state) => (selectHasSession(state) ? state.role : null));
  const signedIn = useAuthStore(selectHasSession);
  const authWallSkipped = useOnboardingStore((state) => state.authWallSkipped);
  const languageChosen = useOnboardingStore((state) => state.languageChosen);
  const onboardingRequired = useOnboardingRequired();

  // A vendor or rider signing in (or relaunching) lands on their dashboard, not the customer shop.
  if (role === 'VENDOR') return <Redirect href="/dashboard" />;
  if (role === 'DRIVER') return <Redirect href="/driver/dashboard" />;
  // First launch: English or Nepali, asked once, before anything else is shown.
  if (!languageChosen) return <Redirect href="/language" />;
  // An account its OTP sign-in just created completes its profile (name, consents) first.
  if (onboardingRequired) return <Redirect href="/complete-profile" />;
  // Boot flow: a visitor who is neither signed in nor browsing as a guest starts at the welcome
  // screen (sign in, or "Skip login").
  if (!signedIn && !authWallSkipped) return <Redirect href="/welcome" />;

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.brand,
        tabBarInactiveTintColor: colors.inactive,
      }}
    >
      <Tabs.Screen
        name="(home)"
        // Pressing "Shops" while a shop's page is open inside the tab goes back to the feed,
        // explicitly: the stack is popped to its first screen rather than left as it was.
        listeners={({ navigation }: { navigation: TabsNavigation }) => ({
          tabPress: () => {
            const action = tabResetAction(navigation.getState(), '(home)');
            if (action !== null) navigation.dispatch(action);
          },
        })}
        options={{
          // The stack inside the tab draws its own header (the feed's, or the shop's with Back).
          headerShown: false,
          title: t('tabs.feed'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="storefront-outline" color={color} size={size} />
          ),
        }}
      />
      {/* The cart is not a tab: it is a screen of the root stack (app/cart.tsx), so opening it
          covers the tab bar. It is reached from the green cart banner of the Shops tab. */}
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

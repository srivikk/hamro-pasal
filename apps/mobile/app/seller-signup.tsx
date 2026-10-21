import type { VendorFulfillmentMode } from '@hamro-pasal/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, router, Stack } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../src/api/http';
import { Button } from '../src/components/Button';
import { KeyboardScreen } from '../src/components/KeyboardScreen';
import { MapPinPicker } from '../src/components/MapPinPicker';
import { fetchSellerSignupOptions, signUpSeller } from '../src/features/seller/seller-api';
import { effectiveDeliveryMode, offeredDeliveryModes } from '../src/features/seller/signup-options';
import type { Coordinates } from '../src/features/territory/territory';
import { tokenSubject } from '../src/lib/access-token-role';
import { useAuthStore } from '../src/store/useAuthStore';
import { useProfileStore } from '../src/store/useProfileStore';
import { selectUsableSignupToken, useSellerSignupStore } from '../src/store/useSellerSignupStore';
import { useToastStore } from '../src/store/useToastStore';

type Field = 'businessName' | 'palika' | 'location';

/**
 * Step 7.7 (SPEC core 11, vendor flow 2): self-signup in the Seller app. The number already passed
 * its OTP (the signup token proves it); the shop is created SANDBOXED on the same account, which
 * now also holds the vendor role, and the app continues signed in as that vendor. Documents follow
 * from the application screen.
 *
 * 2026-10-20: the delivery choices follow the Super Admin's platform switches
 * (GET /api/seller/signup-options): a mode switched off is not offered, and with both off the
 * form is replaced by "New shop registrations are currently paused". The server checks again
 * when the shop is created.
 */
export default function SellerSignupScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const token = useSellerSignupStore(selectUsableSignupToken);
  const phone = useSellerSignupStore((state) => state.phone);
  const showToast = useToastStore((state) => state.show);
  const [businessName, setBusinessName] = useState('');
  const [palika, setPalika] = useState('');
  const [location, setLocation] = useState<Coordinates | null>(null);
  const [chosenMode, setChosenMode] = useState<VendorFulfillmentMode | null>(null);
  const [chosenPlan, setChosenPlan] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, true>>>({});
  const options = useQuery({
    queryKey: ['seller', 'signup-options'],
    queryFn: fetchSellerSignupOptions,
    // The switches can change at any time: asked afresh on every visit and return to the app.
    staleTime: 0,
    refetchOnWindowFocus: 'always',
  });
  const offered = options.data === undefined ? [] : offeredDeliveryModes(options.data);
  const fulfillment = effectiveDeliveryMode(offered, chosenMode);
  // Decided 2026-10-21: a new shop chooses one of the Subscription plans on offer (the cheapest
  // first); Commission and Free plans are assigned by Hamro Pasal.
  const plans = options.data?.subscription_plans ?? [];
  const plan = plans.find((p) => p.id === chosenPlan) ?? plans[0] ?? null;

  const signUp = useMutation({
    mutationFn: signUpSeller,
    retry: false,
    onSuccess: ({ access_token: accessToken, refresh_token: refreshToken }) => {
      useAuthStore.getState().setSession({ accessToken, refreshToken });
      if (phone !== null) useProfileStore.getState().setAccount(phone, tokenSubject(accessToken));
      useSellerSignupStore.getState().clear();
      void queryClient.invalidateQueries();
      showToast(t('sellerSignup.created'), 'info');
      router.replace('/seller-application');
    },
    onError: (error) => {
      const code = error instanceof ApiError ? error.code : null;
      // The Super Admin switched the mode (or both) off after the screen opened: show what is
      // offered now.
      if (code === 'PRICING_PLAN_NOT_SELF_SELECTABLE') {
        setChosenPlan(null);
        void options.refetch();
        showToast(t('sellerSignup.planChanged'), 'error');
        return;
      }
      if (code === 'DELIVERY_MODE_DISABLED' || code === 'SELLER_SIGNUPS_PAUSED') {
        void options.refetch();
        showToast(
          t(code === 'SELLER_SIGNUPS_PAUSED' ? 'sellerSignup.paused' : 'sellerSignup.modeDisabled'),
          'error',
        );
        return;
      }
      if (code === 'INVALID_SIGNUP_TOKEN') {
        useSellerSignupStore.getState().clear();
        showToast(t('sellerSignup.expired'), 'error');
        router.replace('/login');
        return;
      }
      showToast(
        t(code === 'ALREADY_A_SELLER' ? 'sellerSignup.alreadySeller' : 'sellerSignup.failed'),
        'error',
      );
    },
  });

  // Reached without a fresh sign-in (or the token ran out): sign in again first.
  if (token === null) return <Redirect href="/login" />;

  const submit = (): void => {
    if (signUp.isPending) return;
    const missing: Partial<Record<Field, true>> = {
      ...(businessName.trim().length < 2 ? { businessName: true } : {}),
      ...(palika.trim().length < 2 ? { palika: true } : {}),
      ...(location === null ? { location: true } : {}),
    };
    setErrors(missing);
    if (
      Object.keys(missing).length > 0 ||
      location === null ||
      fulfillment === null ||
      plan === null
    ) {
      return;
    }
    signUp.mutate({
      signup_token: token,
      pricing_plan_id: plan.id,
      business_name: businessName.trim(),
      municipality_palika_string: palika.trim(),
      location: { lat: location.latitude, lng: location.longitude },
      fulfillment_mode: fulfillment,
      delivery_scope: 'RADIUS_BOUND',
      radius_km: 3,
    });
  };

  // Until the switches are known nothing can be offered; with none on, nothing can be created.
  if (options.data === undefined || offered.length === 0 || !options.data.signups_open) {
    return (
      <KeyboardScreen testID="seller-signup-screen">
        <Stack.Screen options={{ headerShown: true, title: t('sellerSignup.title') }} />
        <View className="gap-4 p-4">
          {options.isError ? (
            <>
              <Text className="text-sm text-gray-700" testID="seller-signup-options-failed">
                {t('sellerSignup.optionsFailed')}
              </Text>
              <Button label={t('common.retry')} onPress={() => void options.refetch()} />
            </>
          ) : options.data === undefined ? (
            <Text className="text-sm text-gray-500" testID="seller-signup-options-loading">
              {t('sellerSignup.optionsLoading')}
            </Text>
          ) : (
            <View className="gap-2 rounded-xl bg-amber-50 p-4" testID="seller-signup-paused">
              <Text className="text-base font-semibold text-gray-900">
                {t('sellerSignup.paused')}
              </Text>
              <Text className="text-sm text-gray-700">{t('sellerSignup.pausedHint')}</Text>
            </View>
          )}
        </View>
      </KeyboardScreen>
    );
  }

  return (
    <KeyboardScreen testID="seller-signup-screen">
      <Stack.Screen options={{ headerShown: true, title: t('sellerSignup.title') }} />
      <View className="gap-4 p-4">
        <Text className="text-sm text-gray-600">{t('sellerSignup.intro')}</Text>

        <View className="gap-1">
          <Text className="text-sm font-semibold text-gray-800">
            {t('sellerSignup.businessName')}
          </Text>
          <TextInput
            testID="seller-signup-business-name"
            className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-base"
            value={businessName}
            maxLength={100}
            onChangeText={setBusinessName}
          />
          {errors.businessName === true ? (
            <Text className="text-xs text-red-700">{t('sellerSignup.businessNameRequired')}</Text>
          ) : null}
        </View>

        <View className="gap-1">
          <Text className="text-sm font-semibold text-gray-800">{t('sellerSignup.palika')}</Text>
          <TextInput
            testID="seller-signup-palika"
            className="rounded-xl border border-gray-300 bg-white px-4 py-3 text-base"
            value={palika}
            maxLength={120}
            onChangeText={setPalika}
          />
          {errors.palika === true ? (
            <Text className="text-xs text-red-700">{t('sellerSignup.palikaRequired')}</Text>
          ) : null}
        </View>

        <View className="gap-1">
          <Text className="text-sm font-semibold text-gray-800">{t('sellerSignup.location')}</Text>
          <Button
            label={
              location === null ? t('sellerSignup.pinLocation') : t('sellerSignup.locationPinned')
            }
            variant="secondary"
            onPress={() => {
              setPicking(true);
            }}
          />
          {errors.location === true ? (
            <Text className="text-xs text-red-700">{t('sellerSignup.locationRequired')}</Text>
          ) : null}
        </View>

        <View className="gap-1">
          <Text className="text-sm font-semibold text-gray-800">{t('sellerSignup.delivery')}</Text>
          <View className="flex-row gap-2">
            {offered.map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ selected: fulfillment === mode }}
                testID={`seller-signup-${mode}`}
                className={`flex-1 rounded-xl border px-3 py-3 ${
                  fulfillment === mode ? 'border-brand bg-brand-light' : 'border-gray-300 bg-white'
                }`}
                onPress={() => {
                  setChosenMode(mode);
                }}
              >
                <Text className="text-center text-sm font-semibold text-gray-900">
                  {t(`sellerSignup.${mode}`)}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        <View className="gap-1">
          <Text className="text-sm font-semibold text-gray-800">{t('sellerSignup.plan')}</Text>
          {plans.map((offeredPlan) => (
            <Pressable
              key={offeredPlan.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: plan?.id === offeredPlan.id }}
              testID={`seller-signup-plan-${offeredPlan.id}`}
              className={`rounded-xl border px-3 py-3 ${
                plan?.id === offeredPlan.id
                  ? 'border-brand bg-brand-light'
                  : 'border-gray-300 bg-white'
              }`}
              onPress={() => {
                setChosenPlan(offeredPlan.id);
              }}
            >
              <Text className="text-sm font-semibold text-gray-900">{offeredPlan.name}</Text>
              <Text className="text-xs text-gray-600">
                {t('sellerSignup.planFee', { amount: offeredPlan.monthly_fee_npr })}
              </Text>
            </Pressable>
          ))}
          <Text className="text-xs text-gray-500">{t('sellerSignup.planHint')}</Text>
        </View>

        <Button
          label={signUp.isPending ? t('sellerSignup.creating') : t('sellerSignup.submit')}
          disabled={signUp.isPending}
          onPress={submit}
        />
      </View>
      <MapPinPicker
        visible={picking}
        initial={location}
        onConfirm={(position) => {
          setLocation(position);
          setPicking(false);
        }}
        onClose={() => {
          setPicking(false);
        }}
      />
    </KeyboardScreen>
  );
}

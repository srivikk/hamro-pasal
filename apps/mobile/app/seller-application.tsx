import Ionicons from '@expo/vector-icons/Ionicons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, router, Stack } from 'expo-router';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../src/components/Button';
import {
  fetchSellerApplication,
  uploadCitizenshipDocument,
} from '../src/features/seller/seller-api';
import { selectHasSession, useAuthStore } from '../src/store/useAuthStore';
import { useToastStore } from '../src/store/useToastStore';
import { colors } from '../src/theme/colors';

const SELLER_APPLICATION_QUERY_KEY = ['seller', 'application'] as const;

function Step({ done, label, testID }: { done: boolean; label: string; testID: string }) {
  return (
    <View className="flex-row items-center gap-3 py-2" testID={testID}>
      <Ionicons
        name={done ? 'checkmark-circle' : 'ellipse-outline'}
        size={22}
        color={done ? colors.success : colors.inactive}
      />
      <Text className={`text-base ${done ? 'text-gray-900' : 'text-gray-600'}`}>{label}</Text>
    </View>
  );
}

/**
 * Step 7.7 (vendor flow 2): a new shop's checklist before Hamro Pasal reviews it: the PAN and its
 * document (Shop settings), the citizenship document (here). Approval and going LIVE then follow.
 */
export default function SellerApplicationScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isVendor = useAuthStore((state) => selectHasSession(state) && state.role === 'VENDOR');
  const showToast = useToastStore((state) => state.show);
  const application = useQuery({
    queryKey: SELLER_APPLICATION_QUERY_KEY,
    queryFn: fetchSellerApplication,
    enabled: isVendor,
  });
  const upload = useMutation({
    mutationFn: uploadCitizenshipDocument,
    retry: false,
    onSuccess: (view) => {
      queryClient.setQueryData(SELLER_APPLICATION_QUERY_KEY, view);
      showToast(t('sellerApplication.uploaded'), 'info');
    },
    onError: () => {
      showToast(t('sellerApplication.uploadFailed'), 'error');
    },
  });

  if (!isVendor) return <Redirect href="/login" />;

  const pickCitizenship = async (): Promise<void> => {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return;
    upload.mutate({ uri: asset.uri, mimeType: asset.mimeType ?? 'image/jpeg' });
  };

  const view = application.data;
  return (
    <ScrollView className="flex-1 bg-gray-50" contentContainerClassName="gap-4 p-4">
      <Stack.Screen options={{ headerShown: true, title: t('sellerApplication.title') }} />
      {application.isPending ? (
        <ActivityIndicator color={colors.brand} testID="seller-application-loading" />
      ) : view === undefined ? (
        <Button label={t('sellerApplication.retry')} onPress={() => void application.refetch()} />
      ) : (
        <>
          <View className="rounded-2xl bg-white p-4">
            <Text className="text-lg font-bold text-gray-900">{view.business_name}</Text>
            <Text className="text-sm text-gray-600" testID="seller-application-code">
              {view.vendor_code}
            </Text>
            <Text className="mt-2 text-sm text-gray-700" testID="seller-application-status">
              {t(`sellerApplication.status.${view.status}`)}
            </Text>
          </View>
          <View className="rounded-2xl bg-white p-4">
            <Step
              testID="seller-step-tax-id"
              done={view.tax_id_saved}
              label={t('sellerApplication.taxId')}
            />
            <Step
              testID="seller-step-pan"
              done={view.pan_document_uploaded}
              label={t('sellerApplication.pan')}
            />
            <Step
              testID="seller-step-citizenship"
              done={view.citizenship_document_uploaded}
              label={t('sellerApplication.citizenship')}
            />
          </View>
          {view.ready_for_review ? (
            <Text className="text-sm text-gray-700" testID="seller-application-ready">
              {t('sellerApplication.ready')}
            </Text>
          ) : null}
          <Button
            label={
              view.citizenship_document_uploaded
                ? t('sellerApplication.replaceCitizenship')
                : t('sellerApplication.uploadCitizenship')
            }
            variant="secondary"
            disabled={upload.isPending}
            onPress={() => void pickCitizenship()}
          />
          <Button
            label={t('sellerApplication.openSettings')}
            variant="secondary"
            onPress={() => {
              router.push('/settings');
            }}
          />
          <Button
            label={t('sellerApplication.toDashboard')}
            onPress={() => {
              router.replace('/dashboard');
            }}
          />
        </>
      )}
    </ScrollView>
  );
}

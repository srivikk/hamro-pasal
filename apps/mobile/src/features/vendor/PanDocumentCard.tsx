import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Alert, Image, Linking, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { useToastStore } from '../../store/useToastStore';
import { colors } from '../../theme/colors';
import { formatNepalDateTime } from './invoice-math';
import { panDocumentErrorKey, pickPanDocument, type PanDocumentSource } from './pan-document';
import { useTaxIdentityQuery, useUploadPanDocument } from './usePanDocument';

/**
 * The PAN document of the shop (SPEC core 10, "PAN verification"): what is on file, and the two
 * ways to add or replace it, the camera and the gallery. The picture is compressed on the phone
 * before it is sent. It is stored privately: the app shows the photo just taken, never the stored
 * one.
 */
export function PanDocumentCard() {
  const { t } = useTranslation();
  const toast = useToastStore((store) => store.show);
  const identity = useTaxIdentityQuery();
  const upload = useUploadPanDocument();
  // Opening the camera or the gallery, and compressing what came back.
  const [preparing, setPreparing] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const busy = preparing || upload.isPending;

  const onFile = identity.data?.has_pan_document === true;
  const verifiedAt = identity.data?.pan_verified_at ?? null;

  /** A refused permission is explained, never met with silence or a crash. */
  const explainDenied = (source: PanDocumentSource, canAskAgain: boolean): void => {
    const body = `${t(`vendorShop.document.permission.${source}`)} ${t(
      canAskAgain
        ? 'vendorShop.document.permission.tryAgain'
        : 'vendorShop.document.permission.openSettingsHint',
    )}`;
    Alert.alert(
      t('vendorShop.document.permission.title'),
      body,
      canAskAgain
        ? [{ text: t('vendorShop.document.permission.ok') }]
        : [
            { text: t('vendorMarketing.cancel'), style: 'cancel' },
            {
              text: t('vendorShop.document.permission.openSettings'),
              onPress: () => {
                void Linking.openSettings();
              },
            },
          ],
    );
  };

  const run = async (source: PanDocumentSource): Promise<void> => {
    setPreparing(true);
    let picked;
    try {
      picked = await pickPanDocument(source);
    } catch {
      // No camera on the device, or the picture could not be read.
      toast(t(`vendorShop.document.errors.${source}Unavailable`), 'error');
      return;
    } finally {
      setPreparing(false);
    }
    if (picked.status === 'cancelled') return;
    if (picked.status === 'permission_denied') {
      explainDenied(picked.source, picked.canAskAgain);
      return;
    }
    const { file } = picked;
    setPreviewUri(file.uri);
    upload.mutate(file, {
      onSuccess: (result) => {
        toast(
          t(
            result.verification_cleared
              ? 'vendorShop.document.replacedVerified'
              : 'vendorShop.document.uploaded',
          ),
          'success',
        );
      },
      onError: (error) => {
        setPreviewUri(null);
        toast(t(`vendorShop.document.errors.${panDocumentErrorKey(error)}`), 'error');
      },
    });
  };

  const choose = (source: PanDocumentSource): void => {
    if (busy) return;
    // Replacing a verified document sends the shop back to "awaiting verification": say so first.
    if (onFile && verifiedAt !== null) {
      Alert.alert(
        t('vendorShop.document.replaceTitle'),
        t('vendorShop.document.replaceVerifiedBody'),
        [
          { text: t('vendorMarketing.cancel'), style: 'cancel' },
          {
            text: t('vendorShop.document.replaceConfirm'),
            onPress: () => {
              void run(source);
            },
          },
        ],
      );
      return;
    }
    void run(source);
  };

  const status = identity.isPending
    ? null
    : identity.isError
      ? { key: 'statusUnknown' as const, tone: 'text-gray-500', icon: 'help-circle' as const }
      : !onFile
        ? { key: 'statusMissing' as const, tone: 'text-amber-700', icon: 'alert-circle' as const }
        : verifiedAt === null
          ? { key: 'statusPending' as const, tone: 'text-gray-700', icon: 'time' as const }
          : {
              key: 'statusVerified' as const,
              tone: 'text-green-700',
              icon: 'checkmark-circle' as const,
            };

  return (
    <View className="gap-3 border-t border-gray-200 pt-3" testID="pan-document">
      <Text className="text-sm font-semibold text-gray-700">{t('vendorShop.document.title')}</Text>
      <Text className="text-sm text-gray-500">{t('vendorShop.document.hint')}</Text>

      {status === null ? (
        <ActivityIndicator testID="pan-document-loading" color={colors.brand} />
      ) : (
        <View className="flex-row items-center gap-2">
          <Ionicons name={status.icon} size={18} color={colors.inactive} />
          <Text className={`flex-1 text-sm ${status.tone}`} testID="pan-document-status">
            {t(`vendorShop.document.${status.key}`, {
              date: verifiedAt === null ? '' : formatNepalDateTime(verifiedAt).slice(0, 10),
            })}
          </Text>
        </View>
      )}
      {identity.isError ? (
        <Button
          testID="pan-document-retry"
          label={t('vendorShop.document.retryStatus')}
          variant="secondary"
          size="sm"
          onPress={() => {
            void identity.refetch();
          }}
        />
      ) : null}

      {previewUri === null ? null : (
        <Image
          testID="pan-document-preview"
          source={{ uri: previewUri }}
          accessibilityLabel={t('vendorShop.document.previewLabel')}
          resizeMode="contain"
          className="h-40 w-full rounded-xl bg-gray-100"
        />
      )}

      {busy ? (
        <View className="flex-row items-center gap-2" testID="pan-document-busy">
          <ActivityIndicator color={colors.brand} />
          <Text className="text-sm text-gray-700">
            {t(preparing ? 'vendorShop.document.preparing' : 'vendorShop.document.uploading')}
          </Text>
        </View>
      ) : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            testID="pan-document-camera"
            label={t('vendorShop.document.takePhoto')}
            variant="secondary"
            disabled={busy}
            onPress={() => {
              choose('camera');
            }}
          />
        </View>
        <View className="flex-1">
          <Button
            testID="pan-document-library"
            label={t(
              onFile ? 'vendorShop.document.replaceFromGallery' : 'vendorShop.document.fromGallery',
            )}
            variant="secondary"
            disabled={busy}
            onPress={() => {
              choose('library');
            }}
          />
        </View>
      </View>
    </View>
  );
}

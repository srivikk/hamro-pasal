import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../src/components/Button';
import { useAuthStore } from '../../src/store/useAuthStore';

export default function ProfileScreen() {
  const { t } = useTranslation();
  const locale = useAuthStore((state) => state.locale);
  const setLocale = useAuthStore((state) => state.setLocale);

  return (
    <View className="flex-1 bg-neutral-50 p-4">
      <Text className="mb-3 text-lg font-bold text-neutral-900">{t('settings.language')}</Text>
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label={t('settings.english')}
            variant={locale === 'en' ? 'primary' : 'secondary'}
            onPress={() => {
              setLocale('en');
            }}
          />
        </View>
        <View className="flex-1">
          <Button
            label={t('settings.nepali')}
            variant={locale === 'ne' ? 'primary' : 'secondary'}
            onPress={() => {
              setLocale('ne');
            }}
          />
        </View>
      </View>
    </View>
  );
}

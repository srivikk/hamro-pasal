import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { useAuthStore } from '../../store/useAuthStore';

/**
 * DEVELOPMENT ONLY, until OTP login exists (the backend has no token endpoint yet). Accepts a
 * token minted by `pnpm --filter @hamro-pasal/api token:dev` and holds it in memory only, like a
 * real access token (the auth store never persists `accessToken`).
 */
export function DevSignIn() {
  const { t } = useTranslation();
  const signedIn = useAuthStore((state) => state.accessToken !== null);
  const setAccessToken = useAuthStore((state) => state.setAccessToken);
  const clearSession = useAuthStore((state) => state.clearSession);
  const [draft, setDraft] = useState('');

  return (
    <View className="gap-3 rounded-2xl border border-dashed border-neutral-300 p-4">
      <Text className="text-base font-bold text-neutral-900">{t('devAuth.title')}</Text>
      {signedIn ? (
        <>
          <Text className="text-sm text-emerald-800">{t('devAuth.signedIn')}</Text>
          <Button label={t('devAuth.signOut')} variant="secondary" onPress={clearSession} />
        </>
      ) : (
        <>
          <Text className="text-xs text-neutral-600">{t('devAuth.hint')}</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={t('devAuth.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            className="rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm"
          />
          <Button
            label={t('devAuth.use')}
            disabled={draft.trim() === ''}
            onPress={() => {
              setAccessToken(draft.trim());
              setDraft('');
            }}
          />
        </>
      )}
    </View>
  );
}

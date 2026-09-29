import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import type { AppLocale } from '../../i18n/app-locale';
import { formatCountdown } from '../../lib/countdown';

export interface CancellationPanelProps {
  remainingMs: number;
  locale: AppLocale;
  cancelling: boolean;
  onCancel: () => void;
}

/**
 * SPEC journey step 8: the 60 s window. There is deliberately no way to dismiss or skip it; the
 * panel disappears only when the time runs out (or the order is cancelled).
 */
export function CancellationPanel({
  remainingMs,
  locale,
  cancelling,
  onCancel,
}: CancellationPanelProps) {
  const { t } = useTranslation();
  if (remainingMs <= 0) return null;

  return (
    <View className="gap-3 rounded-2xl bg-amber-50 p-4" testID="cancellation-window">
      <Text className="text-base font-semibold text-amber-900" testID="cancellation-countdown">
        {t('order.cancel.countdown', { time: formatCountdown(remainingMs, locale) })}
      </Text>
      <Button
        label={cancelling ? t('order.cancel.cancelling') : t('order.cancel.button')}
        variant="danger"
        disabled={cancelling}
        onPress={onCancel}
      />
    </View>
  );
}

import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { useRiderGpsSimulator } from './rider-gps-simulator';

/**
 * TESTING ONLY (Phase 21 "Rider Mode"): a switch that streams mock GPS positions for this rider
 * over the `/orders` socket, so a customer tracking one of their accepted orders receives them.
 */
export function RiderGpsSimulator() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const { status, lastSent, sentCount } = useRiderGpsSimulator(enabled);

  return (
    <View
      className="gap-2 rounded-2xl border border-dashed border-gray-300 p-4"
      testID="rider-gps-simulator"
    >
      <View className="flex-row items-center justify-between">
        <Text className="text-base font-bold text-gray-900">{t('riderMode.gpsTitle')}</Text>
        <Switch
          testID="rider-gps-switch"
          accessibilityLabel={t('riderMode.gpsTitle')}
          value={enabled}
          onValueChange={setEnabled}
        />
      </View>
      <Text className="text-xs text-gray-500">{t('riderMode.gpsHint')}</Text>
      <Text className="text-sm text-gray-800" testID="rider-gps-status">
        {t(`riderMode.gpsStatus.${status}`)}
      </Text>
      {lastSent === null ? null : (
        <Text className="text-sm text-gray-700" testID="rider-gps-last">
          {t('riderMode.gpsLast', {
            latitude: lastSent.latitude.toFixed(5),
            longitude: lastSent.longitude.toFixed(5),
            count: sentCount,
          })}
        </Text>
      )}
    </View>
  );
}

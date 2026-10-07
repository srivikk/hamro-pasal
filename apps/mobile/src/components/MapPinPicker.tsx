import { useState } from 'react';
import { ActivityIndicator, Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';

import { DEFAULT_MAP_CENTER, mapPinHtml, parseMapPinMessage } from '../features/location/map-pin';
import type { Coordinates } from '../features/territory/territory';
import { usePlaceName } from '../features/location/usePlaceName';
import { Button } from './Button';

/** The name is looked up once the map has rested this long. */
const PLACE_NAME_DELAY_MS = 600;

export interface MapPinPickerProps {
  visible: boolean;
  /** Where the map opens; Kathmandu when there is no pin yet. */
  initial: Coordinates | null;
  onConfirm: (position: Coordinates) => void;
  onClose: () => void;
}

function MapPin({ initial, onConfirm, onClose }: Omit<MapPinPickerProps, 'visible'>) {
  const { t } = useTranslation();
  // The page is built once per opening: rebuilding it on every move would reload the map.
  const [html] = useState(() => mapPinHtml(initial ?? DEFAULT_MAP_CENTER));
  const [center, setCenter] = useState<Coordinates | null>(null);
  const [insideNepal, setInsideNepal] = useState(true);
  const [failed, setFailed] = useState(false);
  const place = usePlaceName(center, PLACE_NAME_DELAY_MS);

  return (
    <SafeAreaView className="flex-1 bg-gray-50">
      <View className="flex-row items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <Text className="text-lg font-bold text-gray-900">{t('mapPin.title')}</Text>
        <Button label={t('address.cancel')} size="sm" variant="secondary" onPress={onClose} />
      </View>
      <View className="flex-1">
        <WebView
          testID="map-pin-webview"
          originWhitelist={['*']}
          // A real origin, so the tile server receives a Referer.
          source={{ html, baseUrl: 'https://hamropasal.app/' }}
          javaScriptEnabled
          domStorageEnabled
          onMessage={(event) => {
            const message = parseMapPinMessage(event.nativeEvent.data);
            if (message === null) return;
            if (message.kind === 'error') {
              setFailed(true);
              return;
            }
            setCenter(message.position);
            setInsideNepal(message.insideNepal);
          }}
          onError={() => {
            setFailed(true);
          }}
        />
        {center === null && !failed ? (
          <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
            <ActivityIndicator size="large" />
          </View>
        ) : null}
      </View>
      <View className="gap-2 border-t border-gray-200 bg-white p-4">
        {failed ? (
          <Text className="text-sm text-red-700" testID="map-pin-failed">
            {t('mapPin.failed')}
          </Text>
        ) : (
          <>
            <Text className="text-xs text-gray-500">{t('mapPin.hint')}</Text>
            {/* The place under the pin by name; latitude and longitude are never shown. */}
            <Text
              className="text-base font-semibold text-gray-900"
              numberOfLines={2}
              testID="map-pin-value"
            >
              {center === null
                ? t('mapPin.loading')
                : place.loading
                  ? t('mapPin.naming')
                  : (place.name ?? t('mapPin.unnamed'))}
            </Text>
            {insideNepal ? null : (
              <Text className="text-sm text-red-700" testID="map-pin-outside">
                {t('address.errors.pin')}
              </Text>
            )}
          </>
        )}
        <Button
          label={t('mapPin.confirm')}
          disabled={center === null || !insideNepal || failed}
          onPress={() => {
            if (center !== null) onConfirm(center);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

/**
 * SPEC Nepal localizations §3 "Drop a Pin": the customer moves a map under a fixed pin and
 * confirms. The map is a Leaflet page on OpenStreetMap tiles inside the WebView the app already
 * ships, so it needs no native map module and no API key (it does need a connection).
 */
export function MapPinPicker({ visible, ...props }: MapPinPickerProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      {/* Mounted per opening, so each visit starts from the given position. */}
      {visible ? <MapPin {...props} /> : null}
    </Modal>
  );
}

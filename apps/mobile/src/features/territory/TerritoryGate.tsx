import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { ActivityIndicator, Linking, Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import type { TerritoryDeps } from './territory';
import { TERRITORY_BLOCKED_MESSAGE } from './territory';
import { useTerritorySimulator, type TerritorySimulation } from './territory-simulator';
import { useTerritoryGuard } from './useTerritoryGuard';

/** __DEV__ only: switch between real GPS and simulated positions inside/outside Nepal. */
export function TerritorySimulatorControls() {
  const { t } = useTranslation();
  const simulation = useTerritorySimulator((state) => state.simulation);
  const setSimulation = useTerritorySimulator((state) => state.setSimulation);
  const options: TerritorySimulation[] = ['off', 'inside', 'outside'];

  return (
    <View className="gap-2 rounded-2xl border border-dashed border-neutral-400 p-3">
      <Text className="text-xs font-bold uppercase text-neutral-500">
        {t('territory.simulator.title')}
      </Text>
      <View className="flex-row gap-2">
        {options.map((option) => (
          <View key={option} className="flex-1">
            <Button
              label={t(`territory.simulator.${option}`)}
              size="sm"
              variant={simulation === option ? 'primary' : 'secondary'}
              testID={`territory-simulate-${option}`}
              onPress={() => {
                setSimulation(option);
              }}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function FullScreen({ children, testID }: { children: ReactNode; testID: string }) {
  return (
    <Modal
      visible
      animationType="none"
      presentationStyle="fullScreen"
      // Unskippable: the Android back button must not dismiss the gate.
      onRequestClose={() => undefined}
    >
      <View className="flex-1 items-center justify-center gap-5 bg-white px-8" testID={testID}>
        {children}
        {__DEV__ ? <TerritorySimulatorControls /> : null}
      </View>
    </Modal>
  );
}

/**
 * Root-level gate for SPEC §1. Until the device is confirmed inside Nepal, a full-screen modal
 * sits above every route, so nothing behind it can be used. There is no close control.
 */
export function TerritoryGate({ deps }: { deps?: TerritoryDeps }) {
  const { t } = useTranslation();
  const { status, canAskAgain, recheck } = useTerritoryGuard(deps);

  switch (status) {
    case 'allowed':
      return null;
    case 'checking':
      return (
        <FullScreen testID="territory-checking">
          <ActivityIndicator size="large" />
          <Text className="text-base text-neutral-700">{t('territory.checking')}</Text>
        </FullScreen>
      );
    case 'blocked':
      return (
        <FullScreen testID="territory-blocked">
          <Ionicons name="ban" size={56} color="#B91C1C" />
          {/* SPEC §1 text, verbatim in every language. */}
          <Text
            className="text-center text-2xl font-bold text-neutral-900"
            accessibilityRole="header"
          >
            {TERRITORY_BLOCKED_MESSAGE}
          </Text>
          <Text className="text-center text-base text-neutral-600">
            {t('territory.blockedDetail')}
          </Text>
        </FullScreen>
      );
    case 'permission_denied':
      return (
        <FullScreen testID="territory-permission">
          <Ionicons name="location-outline" size={56} color="#737373" />
          <Text className="text-center text-xl font-bold text-neutral-900">
            {t('territory.permissionTitle')}
          </Text>
          <Text className="text-center text-base text-neutral-600">
            {t('territory.permissionBody')}
          </Text>
          {canAskAgain ? (
            <Button label={t('territory.allow')} onPress={recheck} />
          ) : (
            <Button
              label={t('territory.openSettings')}
              onPress={() => {
                void Linking.openSettings();
              }}
            />
          )}
          <Button label={t('common.retry')} variant="secondary" onPress={recheck} />
        </FullScreen>
      );
    case 'unavailable':
      return (
        <FullScreen testID="territory-unavailable">
          <Ionicons name="navigate-circle-outline" size={56} color="#737373" />
          <Text className="text-center text-xl font-bold text-neutral-900">
            {t('territory.unavailableTitle')}
          </Text>
          <Text className="text-center text-base text-neutral-600">
            {t('territory.unavailableBody')}
          </Text>
          <Button label={t('common.retry')} onPress={recheck} />
        </FullScreen>
      );
  }
}

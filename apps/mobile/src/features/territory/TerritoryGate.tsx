import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/Button';
import { selectHasSession, useAuthStore } from '../../store/useAuthStore';
import { useOnboardingStore } from '../../store/useOnboardingStore';
import { SPLASH_MIN_DURATION_MS, SplashView } from '../boot/SplashView';
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
    <View className="gap-2 rounded-2xl border border-dashed border-gray-400 p-3">
      <Text className="text-xs font-bold uppercase text-gray-500">
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

function FullScreen({ children }: { children: ReactNode }) {
  return (
    <Modal
      visible
      animationType="none"
      presentationStyle="fullScreen"
      // Unskippable: the Android back button must not dismiss the splash or the gate.
      onRequestClose={() => undefined}
    >
      {children}
    </Modal>
  );
}

/** Runs the location check; the splash stays up until it has an answer. */
function LocationCheck({ deps }: { deps?: TerritoryDeps }) {
  const { t } = useTranslation();
  // A visitor headed for the welcome screen (not signed in, login not skipped) is asked for the
  // location permission there, while looking at it; everyone else is asked here, at boot.
  const [promptAtBoot] = useState(
    () =>
      selectHasSession(useAuthStore.getState()) || useOnboardingStore.getState().authWallSkipped,
  );
  const { status } = useTerritoryGuard(deps, { promptAtBoot });

  switch (status) {
    case 'checking':
      return (
        <FullScreen>
          <SplashView />
        </FullScreen>
      );
    case 'blocked':
      return (
        <FullScreen>
          <View
            className="flex-1 items-center justify-center gap-5 bg-white px-8"
            testID="territory-blocked"
          >
            <Ionicons name="ban" size={56} color="#B91C1C" />
            {/* SPEC §1 text, verbatim in every language. */}
            <Text
              className="text-center text-2xl font-bold text-gray-900"
              accessibilityRole="header"
            >
              {TERRITORY_BLOCKED_MESSAGE}
            </Text>
            <Text className="text-center text-base text-gray-500">
              {t('territory.blockedDetail')}
            </Text>
            {__DEV__ ? <TerritorySimulatorControls /> : null}
          </View>
        </FullScreen>
      );
    // Inside Nepal, or the position is unknown (permission refused, no fix): the app opens.
    case 'allowed':
    case 'permission_denied':
    case 'unavailable':
      return null;
  }
}

/**
 * The boot sequence and SPEC §1's gate, above every route. First the splash; then the position
 * check, with the splash still up. The OS location prompt belongs to that check for a returning
 * customer or guest; for a first-time visitor it is deferred to the welcome screen:
 *
 * - inside Nepal: the position is kept for the Home screen and the app opens;
 * - outside Nepal: the blocking screen, and the local cache is purged;
 * - permission refused or no fix: the app opens without a position (the customer selects a
 *   location by hand). The check runs again whenever the app returns to the foreground.
 */
export function TerritoryGate({
  deps,
  splashMinMs = SPLASH_MIN_DURATION_MS,
}: {
  deps?: TerritoryDeps;
  splashMinMs?: number;
}) {
  const [splashDone, setSplashDone] = useState(splashMinMs <= 0);

  useEffect(() => {
    if (splashMinMs <= 0) return;
    const timer = setTimeout(() => {
      setSplashDone(true);
    }, splashMinMs);
    return () => {
      clearTimeout(timer);
    };
  }, [splashMinMs]);

  if (!splashDone) {
    return (
      <FullScreen>
        <SplashView />
      </FullScreen>
    );
  }
  return <LocationCheck {...(deps === undefined ? {} : { deps })} />;
}

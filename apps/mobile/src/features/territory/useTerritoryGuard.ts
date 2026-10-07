import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { deviceTerritoryDeps } from './device-territory';
import { useBrowseLocationStore } from '../../store/useBrowseLocationStore';
import { purgeLocalData } from './purge-local-data';
import { checkTerritory, type TerritoryDeps, type TerritoryVerdict } from './territory';
import { useTerritorySimulator } from './territory-simulator';

export type TerritoryStatus = 'checking' | TerritoryVerdict['status'];

export interface TerritoryGuard {
  status: TerritoryStatus;
  /** For the permission-denied case: whether the OS will show the permission prompt again. */
  canAskAgain: boolean;
  /** Runs the check again (after granting permission, turning GPS on, or travelling). */
  recheck: () => void;
}

/**
 * SPEC §1 tenant isolation and the boot location capture. Checks the device position on launch
 * and whenever the app returns to the foreground (never asking then). The OS permission prompt
 * is shown by the launch check when `promptAtBoot`, else when the welcome screen requests it
 * (useBrowseLocationStore.requestLocationPrompt).
 * On `blocked` the app locks and the local cache is purged at once; on `allowed` the position is
 * kept in useBrowseLocationStore for the Home screen; without a position the app opens anyway.
 * `deps` defaults to the real device services (or the __DEV__ simulator).
 */
export function useTerritoryGuard(
  deps?: TerritoryDeps,
  { promptAtBoot = true }: { promptAtBoot?: boolean } = {},
): TerritoryGuard {
  const queryClient = useQueryClient();
  const promptRequested = useBrowseLocationStore((state) => state.locationPrompt === 'requested');
  // The boot value only: a later change of session must not re-run the check.
  const bootPrompt = useRef(promptAtBoot);
  const simulation = useTerritorySimulator((state) => state.simulation);
  const [verdict, setVerdict] = useState<TerritoryVerdict | null>(null);
  // Only the latest check may update the verdict (a slow GPS fix must not overwrite a newer one).
  const latestRun = useRef(0);

  const run = useCallback(
    async (prompt: boolean) => {
      const runId = ++latestRun.current;
      const services = deps ?? deviceTerritoryDeps();
      const result = await checkTerritory(services, { prompt });
      if (runId !== latestRun.current) return;
      if (result.status === 'blocked') purgeLocalData(queryClient);
      const { setDevice } = useBrowseLocationStore.getState();
      if (result.status === 'allowed') {
        const { latitude: lat, longitude: lng } = result.coordinates;
        const known = useBrowseLocationStore.getState().device;
        // Keep the name already found for this spot; look one up otherwise (never blocks boot).
        const label = known?.lat === lat && known.lng === lng ? known.label : null;
        setDevice({ lat, lng, label });
        if (label === null && services.describePlace !== undefined) {
          void services
            .describePlace(result.coordinates)
            .catch(() => null)
            .then((name) => {
              const current = useBrowseLocationStore.getState().device;
              if (name !== null && current?.lat === lat && current.lng === lng) {
                setDevice({ lat, lng, label: name });
              }
            });
        }
      } else {
        setDevice(null);
      }
      useBrowseLocationStore.getState().markDeviceChecked();
      // A run that showed (or could show) the OS prompt answers the deferred request too.
      if (prompt) useBrowseLocationStore.getState().markLocationPromptAnswered();
      setVerdict(result);
    },
    [queryClient, deps],
  );

  useEffect(() => {
    void run(bootPrompt.current);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run(false);
    });
    return () => {
      subscription.remove();
    };
    // The simulator mode is a dependency so switching it re-runs the check at once.
  }, [run, simulation]);

  // The welcome screen asked for the OS prompt (it was held back at boot so that it appears
  // over that screen, not over the splash).
  useEffect(() => {
    if (promptRequested) void run(true);
  }, [promptRequested, run]);

  return {
    status: verdict?.status ?? 'checking',
    canAskAgain: verdict?.status === 'permission_denied' ? verdict.canAskAgain : true,
    recheck: () => {
      void run(true);
    },
  };
}

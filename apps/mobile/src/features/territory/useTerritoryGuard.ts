import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { deviceTerritoryDeps } from './device-territory';
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
 * SPEC §1 tenant isolation. Checks the device position on launch and whenever the app returns to
 * the foreground. The app is usable only while the status is `allowed`; on `blocked` the local
 * cache is purged at once. `deps` defaults to the real device services (or the __DEV__ simulator).
 */
export function useTerritoryGuard(deps?: TerritoryDeps): TerritoryGuard {
  const queryClient = useQueryClient();
  const simulation = useTerritorySimulator((state) => state.simulation);
  const [verdict, setVerdict] = useState<TerritoryVerdict | null>(null);
  // Only the latest check may update the verdict (a slow GPS fix must not overwrite a newer one).
  const latestRun = useRef(0);

  const run = useCallback(async () => {
    const runId = ++latestRun.current;
    const result = await checkTerritory(deps ?? deviceTerritoryDeps());
    if (runId !== latestRun.current) return;
    if (result.status === 'blocked') purgeLocalData(queryClient);
    setVerdict(result);
  }, [queryClient, deps]);

  useEffect(() => {
    void run();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void run();
    });
    return () => {
      subscription.remove();
    };
    // The simulator mode is a dependency so switching it re-runs the check at once.
  }, [run, simulation]);

  return {
    status: verdict?.status ?? 'checking',
    canAskAgain: verdict?.status === 'permission_denied' ? verdict.canAskAgain : true,
    recheck: () => {
      void run();
    },
  };
}

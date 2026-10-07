import * as Location from 'expo-location';

import { describePlace } from '../location/describe-place';
import type { Coordinates, TerritoryDeps } from './territory';
import { SIMULATED_POSITIONS, useTerritorySimulator } from './territory-simulator';

/** A cached fix younger than this is good enough for a country-level check. */
const LAST_KNOWN_MAX_AGE_MS = 10 * 60_000;
/** A fresh GPS fix can take a while on budget phones; give up (retryably) after this. */
const POSITION_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function devicePosition(): Promise<Coordinates | null> {
  try {
    // A recent cached fix answers instantly; a fresh one is requested only when there is none.
    const lastKnown = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
    const fix =
      lastKnown ??
      (await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        POSITION_TIMEOUT_MS,
      ));
    return fix === null ? null : { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
  } catch {
    return null;
  }
}

/** Real device services, or the __DEV__ simulator's fixed position when one is selected. */
export function deviceTerritoryDeps(): TerritoryDeps {
  const simulation = __DEV__ ? useTerritorySimulator.getState().simulation : 'off';
  if (simulation !== 'off') {
    const simulated = SIMULATED_POSITIONS[simulation];
    return {
      requestPermission: () => Promise.resolve({ granted: true, canAskAgain: true }),
      getPosition: () => Promise.resolve(simulated.coordinates),
      reverseGeocodeCountry: () => Promise.resolve(simulated.countryCode),
      describePlace,
    };
  }
  return {
    requestPermission: async () => {
      const { granted, canAskAgain } = await Location.requestForegroundPermissionsAsync();
      return { granted, canAskAgain };
    },
    currentPermission: async () => {
      const { granted, canAskAgain } = await Location.getForegroundPermissionsAsync();
      return { granted, canAskAgain };
    },
    getPosition: devicePosition,
    reverseGeocodeCountry: async (coordinates) => {
      const [place] = await Location.reverseGeocodeAsync(coordinates);
      return place?.isoCountryCode ?? null;
    },
    // The name shown on Home (device geocoder, then OpenStreetMap).
    describePlace,
  };
}

/** Current position for the address pin: the same source (and simulator) as the geofence. */
export async function currentPinPosition(): Promise<Coordinates | null> {
  const deps = deviceTerritoryDeps();
  const permission = await deps.requestPermission();
  return permission.granted ? deps.getPosition() : null;
}

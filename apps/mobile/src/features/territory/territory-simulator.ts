import { create } from 'zustand';

import type { Coordinates } from './territory';

/*
 * DEVELOPMENT ONLY (__DEV__): replaces the device position so both sides of the geofence can be
 * exercised from a desk anywhere. Memory only, so a reload always returns to the real GPS.
 */

export type TerritorySimulation = 'off' | 'inside' | 'outside';

export const SIMULATED_POSITIONS: Record<
  Exclude<TerritorySimulation, 'off'>,
  { coordinates: Coordinates; countryCode: string }
> = {
  // Kathmandu Durbar Square.
  inside: { coordinates: { latitude: 27.7045, longitude: 85.3077 }, countryCode: 'NP' },
  // New Delhi: well outside Nepal's box.
  outside: { coordinates: { latitude: 28.6139, longitude: 77.209 }, countryCode: 'IN' },
};

interface TerritorySimulatorState {
  simulation: TerritorySimulation;
  setSimulation: (simulation: TerritorySimulation) => void;
}

export const useTerritorySimulator = create<TerritorySimulatorState>()((set) => ({
  simulation: 'off',
  setSimulation: (simulation) => {
    set({ simulation });
  },
}));

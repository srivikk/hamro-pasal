import { isWithinNepalBoundingBox } from '@hamro-pasal/shared-types';
import { create } from 'zustand';

/** A place the customer chose to browse shops around, instead of where the phone is. */
export interface BrowseLocation {
  lat: number;
  lng: number;
  /** Shown in the Home header: a saved address line, the searched text, or the coordinates. */
  label: string;
  /** Known only for a saved address; without it CITY_WIDE shops cannot match (SPEC §2). */
  municipalityPalika: string | null;
}

/** Where the phone is, captured at boot when the customer allowed location access. */
export interface DeviceLocation {
  lat: number;
  lng: number;
  /** The neighbourhood or town the device's geocoder named, or null when it named none. */
  label: string | null;
}

interface BrowseLocationState {
  /**
   * The manual choice, or null to follow the device position (else the delivery address).
   * Memory only. It changes what the feed and menus are asked for, never where an order is
   * delivered.
   */
  override: BrowseLocation | null;
  /**
   * The device position confirmed inside Nepal by the boot check, or null (permission refused,
   * no fix, or not checked yet). Memory only: captured again on every launch.
   */
  device: DeviceLocation | null;
  /**
   * The boot location check has given its first answer (allowed, refused or no fix). Until then
   * "no location" only means "not known yet", and Home must not ask the customer to pick one.
   */
  deviceChecked: boolean;
  /**
   * The OS location prompt, when it is deferred to the welcome screen: `requested` asks the
   * location check (TerritoryGate) to run again WITH the prompt; `answered` means that run has
   * finished, so `device` now says whether the customer allowed it.
   */
  locationPrompt: 'idle' | 'requested' | 'answered';
  /** Returns false (and keeps the current location) for a point outside Nepal (SPEC §1). */
  setOverride: (location: BrowseLocation) => boolean;
  clearOverride: () => void;
  setDevice: (device: DeviceLocation | null) => void;
  markDeviceChecked: () => void;
  requestLocationPrompt: () => void;
  markLocationPromptAnswered: () => void;
}

export const useBrowseLocationStore = create<BrowseLocationState>()((set) => ({
  override: null,
  device: null,
  deviceChecked: false,
  locationPrompt: 'idle',
  setOverride: (location) => {
    if (!isWithinNepalBoundingBox({ lat: location.lat, lng: location.lng })) return false;
    set({ override: location });
    return true;
  },
  clearOverride: () => {
    set({ override: null });
  },
  setDevice: (device) => {
    set({ device });
  },
  markDeviceChecked: () => {
    set({ deviceChecked: true });
  },
  requestLocationPrompt: () => {
    set((state) => (state.locationPrompt === 'idle' ? { locationPrompt: 'requested' } : state));
  },
  markLocationPromptAnswered: () => {
    set({ locationPrompt: 'answered' });
  },
}));

import { useEffect, useState } from 'react';

import type { Coordinates } from '../territory/territory';
import { describePlace } from './describe-place';

export interface PlaceNameState {
  /** The readable name, or null while it is unknown (not asked yet, loading, or unnameable). */
  name: string | null;
  loading: boolean;
}

/**
 * The human-readable name of `position`, looked up `delayMs` after it last changed (so a map
 * being dragged asks once, when it rests). A slower answer for an earlier position is dropped.
 */
export function usePlaceName(position: Coordinates | null, delayMs = 0): PlaceNameState {
  const latitude = position?.latitude ?? null;
  const longitude = position?.longitude ?? null;
  const [resolved, setResolved] = useState<{ key: string; name: string | null } | null>(null);
  const key =
    latitude === null || longitude === null ? null : `${String(latitude)},${String(longitude)}`;

  useEffect(() => {
    if (latitude === null || longitude === null) return;
    const requested = `${String(latitude)},${String(longitude)}`;
    let current = true;
    const timer = setTimeout(() => {
      void describePlace({ latitude, longitude }).then((name) => {
        if (current) setResolved({ key: requested, name });
      });
    }, delayMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [latitude, longitude, delayMs]);

  const known = key !== null && resolved?.key === key;
  return { name: known ? resolved.name : null, loading: key !== null && !known };
}

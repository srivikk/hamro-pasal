import {
  ORDER_SOCKET_EVENTS,
  RIDER_LOCATION_PUSH_INTERVAL_MS,
  riderLocationAckSchema,
  type RiderLocationRequest,
} from '@hamro-pasal/shared-types';
import { useEffect, useState } from 'react';

import { createOrdersSocket, type OrdersConnection } from '../../services/socket';

/*
 * TESTING ONLY (Phase 21 "Rider Mode"): stands in for the device's GPS so a rider's position can
 * be streamed without walking around. A real build would feed expo-location's watcher into the
 * same `rider:location` event.
 */

/** How often a mock position is sent: the server's own push period, so each push is a new point. */
export const RIDER_GPS_SIMULATION_INTERVAL_MS = RIDER_LOCATION_PUSH_INTERVAL_MS;
/** Server acknowledgement deadline for one position. */
export const RIDER_LOCATION_ACK_TIMEOUT_MS = 10_000;

const ROUTE_START = { latitude: 27.7154, longitude: 85.3123 }; // Thamel, Kathmandu
const ROUTE_END = { latitude: 27.6727, longitude: 85.3249 }; // Patan Durbar Square, Lalitpur
/** Reports from one end of the route to the other. */
export const MOCK_ROUTE_STEPS = 20;

/**
 * The mock position at report `step` (0-based): a straight line from Thamel to Patan and back,
 * forever, rounded to 6 decimals (about 0.1 m).
 */
export function mockRiderPosition(step: number): RiderLocationRequest {
  const lap = step % (MOCK_ROUTE_STEPS * 2);
  const along = (lap <= MOCK_ROUTE_STEPS ? lap : MOCK_ROUTE_STEPS * 2 - lap) / MOCK_ROUTE_STEPS;
  const between = (from: number, to: number): number =>
    Math.round((from + (to - from) * along) * 1e6) / 1e6;
  return {
    latitude: between(ROUTE_START.latitude, ROUTE_END.latitude),
    longitude: between(ROUTE_START.longitude, ROUTE_END.longitude),
  };
}

export type RiderGpsStatus = 'off' | 'connecting' | 'streaming' | 'refused';

export interface RiderGpsSimulation {
  readonly status: RiderGpsStatus;
  /** The last position the server acknowledged, if any. */
  readonly lastSent: RiderLocationRequest | null;
  /** Positions acknowledged since the simulation was switched on. */
  readonly sentCount: number;
}

const OFF: RiderGpsSimulation = { status: 'off', lastSent: null, sentCount: 0 };
/** A session that was just switched on: nothing acknowledged yet. */
const CONNECTING: RiderGpsSimulation = { status: 'connecting', lastSent: null, sentCount: 0 };

/**
 * While `enabled`, opens the `/orders` socket (shared token lifecycle) and emits a mock
 * `rider:location` at once on every connect and then every RIDER_GPS_SIMULATION_INTERVAL_MS.
 * `streaming` once the server acknowledged a position; `refused` when it answered with an error
 * (e.g. FORBIDDEN for an account that is not a rider). Switching off closes the socket.
 */
export function useRiderGpsSimulator(
  enabled: boolean,
  connect: () => OrdersConnection = createOrdersSocket,
): RiderGpsSimulation {
  // The running session's state; while switched off the hook reports OFF whatever this holds.
  const [session, setSession] = useState<RiderGpsSimulation>(CONNECTING);

  useEffect(() => {
    if (!enabled) return undefined;
    const { socket, close } = connect();
    let step = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let active = true;

    const send = (): void => {
      const position = mockRiderPosition(step);
      step += 1;
      socket
        .timeout(RIDER_LOCATION_ACK_TIMEOUT_MS)
        .emit(ORDER_SOCKET_EVENTS.riderLocation, position, (error, response) => {
          if (!active || error instanceof Error) return; // a lost ack: the next tick sends again
          const ack = riderLocationAckSchema.safeParse(response);
          if (ack.success && ack.data.ok) {
            setSession((current) => ({
              status: 'streaming',
              lastSent: position,
              sentCount: current.sentCount + 1,
            }));
          } else {
            setSession((current) => ({ ...current, status: 'refused' }));
          }
        });
    };
    const stopTimer = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onConnect = (): void => {
      stopTimer();
      send();
      timer = setInterval(send, RIDER_GPS_SIMULATION_INTERVAL_MS);
    };
    const onDisconnect = (): void => {
      stopTimer();
      setSession((current) => ({ ...current, status: 'connecting' }));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.connect();

    return () => {
      active = false;
      stopTimer();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      close();
      setSession(CONNECTING); // the next session starts clean
    };
  }, [enabled, connect]);

  return enabled ? session : OFF;
}

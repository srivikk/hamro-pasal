import { riderLocationRequestSchema } from '@hamro-pasal/shared-types';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';

import { useAuthStore } from '../../store/useAuthStore';
import { FakeSocket } from '../../test/fake-socket';
import { setupApiTestEnvironment, TEST_ACCESS_TOKEN } from '../../test/msw';
import { renderHookWithProviders, renderWithProviders } from '../../test/render';
import {
  MOCK_ROUTE_STEPS,
  mockRiderPosition,
  RIDER_GPS_SIMULATION_INTERVAL_MS,
  useRiderGpsSimulator,
} from './rider-gps-simulator';
import { RiderModeEntry } from './RiderModeEntry';

let mockSocket = new FakeSocket();
jest.mock('socket.io-client', () => ({
  io: (url: string, options: { auth?: unknown }) => mockSocket.created(url, options),
}));

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn() },
}));

setupApiTestEnvironment();

const ACK = { ok: true, recorded_at: '2026-10-03T10:45:00.000Z' };
const sent = () => mockSocket.emittedOf('rider:location');

/** Lets the handshake's auth promise resolve (the socket connects after a microtask). */
async function handshake(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms = RIDER_GPS_SIMULATION_INTERVAL_MS): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSocket = new FakeSocket();
});

describe('mockRiderPosition', () => {
  it('starts in Thamel, reaches Patan after MOCK_ROUTE_STEPS and comes back', () => {
    expect(mockRiderPosition(0)).toEqual({ latitude: 27.7154, longitude: 85.3123 });
    expect(mockRiderPosition(MOCK_ROUTE_STEPS)).toEqual({ latitude: 27.6727, longitude: 85.3249 });
    expect(mockRiderPosition(MOCK_ROUTE_STEPS * 2)).toEqual(mockRiderPosition(0));
    expect(mockRiderPosition(MOCK_ROUTE_STEPS + 1)).toEqual(
      mockRiderPosition(MOCK_ROUTE_STEPS - 1),
    );
  });

  it('moves at every step and always satisfies the server contract (inside Nepal)', () => {
    for (let step = 0; step < MOCK_ROUTE_STEPS * 2; step += 1) {
      const position = mockRiderPosition(step);
      expect(riderLocationRequestSchema.safeParse(position).success).toBe(true);
      expect(position).not.toEqual(mockRiderPosition(step + 1));
    }
  });
});

describe('useRiderGpsSimulator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing while disabled', async () => {
    const { result } = renderHookWithProviders(() => useRiderGpsSimulator(false));
    await tick();

    expect(result.current).toEqual({ status: 'off', lastSent: null, sentCount: 0 });
    expect(mockSocket.connectCalls).toBe(0);
  });

  it('authenticates on /orders with the access token and sends the first position at once', async () => {
    const { result } = renderHookWithProviders(() => useRiderGpsSimulator(true));
    expect(result.current.status).toBe('connecting');
    await handshake();

    expect(mockSocket.url).toBe('http://api.hamropasal.test/orders');
    expect(mockSocket.handshakes).toEqual([{ token: TEST_ACCESS_TOKEN }]);
    expect(sent()).toEqual([mockRiderPosition(0)]);
    expect(result.current.status).toBe('connecting'); // not acknowledged yet

    mockSocket.answerLast('rider:location', ACK);

    expect(result.current).toEqual({
      status: 'streaming',
      lastSent: mockRiderPosition(0),
      sentCount: 1,
    });
  });

  it('sends the next point of the route every interval, and nothing in between', async () => {
    const { result } = renderHookWithProviders(() => useRiderGpsSimulator(true));
    await handshake();
    mockSocket.answerLast('rider:location', ACK);

    await tick(RIDER_GPS_SIMULATION_INTERVAL_MS - 1);
    expect(sent()).toHaveLength(1);
    await tick(1);
    expect(sent()).toEqual([mockRiderPosition(0), mockRiderPosition(1)]);
    mockSocket.answerLast('rider:location', ACK);
    await tick();

    expect(sent()).toEqual([mockRiderPosition(0), mockRiderPosition(1), mockRiderPosition(2)]);
    expect(result.current).toMatchObject({ lastSent: mockRiderPosition(1), sentCount: 2 });
  });

  it('reports a refusal (an account that is not a rider) and counts nothing', async () => {
    const { result } = renderHookWithProviders(() => useRiderGpsSimulator(true));
    await handshake();

    mockSocket.answerLast('rider:location', {
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Only riders report a position' },
    });

    expect(result.current).toEqual({ status: 'refused', lastSent: null, sentCount: 0 });
  });

  it('ignores a lost ack and keeps sending', async () => {
    const { result } = renderHookWithProviders(() => useRiderGpsSimulator(true));
    await handshake();

    mockSocket.answerLast('rider:location', undefined, new Error('operation has timed out'));
    await tick();

    expect(result.current.status).toBe('connecting');
    expect(sent()).toHaveLength(2);
  });

  it('pauses while disconnected and resumes with a position on reconnect', async () => {
    const { result } = renderHookWithProviders(() => useRiderGpsSimulator(true));
    await handshake();
    mockSocket.answerLast('rider:location', ACK);

    mockSocket.drop();
    await tick();
    await tick();
    expect(sent()).toHaveLength(1);
    expect(result.current.status).toBe('connecting');

    mockSocket.reconnect();
    await handshake();
    expect(sent()).toHaveLength(2);
    await tick();
    expect(sent()).toHaveLength(3); // one timer, not two
  });

  it('closes the socket and stops sending when switched off or unmounted', async () => {
    const { result, rerender, unmount } = renderHookWithProviders(
      ({ enabled }: { enabled: boolean }) => useRiderGpsSimulator(enabled),
      { initialProps: { enabled: true } },
    );
    await handshake();
    mockSocket.answerLast('rider:location', ACK);

    rerender({ enabled: false });
    await tick();
    await tick();

    expect(mockSocket.connected).toBe(false);
    expect(sent()).toHaveLength(1);
    expect(result.current).toEqual({ status: 'off', lastSent: null, sentCount: 0 });
    unmount();
  });
});

describe('RiderModeEntry (Profile, testing only)', () => {
  it('ends the current session and opens sign-in for the rider number', () => {
    useAuthStore.getState().setSession({ accessToken: TEST_ACCESS_TOKEN, refreshToken: 'r.jwt' });
    renderWithProviders(<RiderModeEntry />);
    expect(screen.getByText('Rider Mode (testing)')).toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('rider-mode-toggle'));

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(router.push).toHaveBeenCalledWith('/login');
  });
});

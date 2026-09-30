import { io } from 'socket.io-client';

import { useAuthStore } from '../store/useAuthStore';
import { FakeSocket } from '../test/fake-socket';
import {
  CHAT_NAMESPACE,
  authenticatedSocketOptions,
  createChatSocket,
  HEARTBEAT_INTERVAL_MS,
  reconnectDelayMs,
  type SocketFactory,
} from './socket';

describe('chat socket configuration', () => {
  it('backs off 1 s, 2 s, 4 s, 8 s, 16 s, then holds at 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('targets the /chat namespace of the API with the reconnection policy', () => {
    const factory = jest.fn<ReturnType<SocketFactory>, Parameters<SocketFactory>>(
      () => new FakeSocket() as unknown as ReturnType<SocketFactory>,
    );

    createChatSocket(factory);

    expect(factory).toHaveBeenCalledWith(
      'http://api.hamropasal.test/chat',
      expect.objectContaining({
        transports: ['websocket'],
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: Number.POSITIVE_INFINITY,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 30_000,
        randomizationFactor: 0,
      }),
    );
    expect(CHAT_NAMESPACE).toBe('/chat');
  });

  it('configures the real Socket.io manager with that exact schedule', () => {
    const socket = io('http://api.hamropasal.test/chat', authenticatedSocketOptions());

    expect(socket.io.reconnection()).toBe(true);
    expect(socket.io.reconnectionDelay()).toBe(1000);
    expect(socket.io.reconnectionDelayMax()).toBe(30_000);
    // No jitter: the doubling schedule above is exact.
    expect(socket.io.randomizationFactor()).toBe(0);
    expect(socket.connected).toBe(false);
    socket.close();
  });

  it('documents the 25 s heartbeat the server must advertise', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
  });

  it('authenticates with the access token current at each (re)connect', async () => {
    const { auth } = authenticatedSocketOptions();
    if (typeof auth !== 'function') throw new Error('auth must be a callback');
    const handshake = () =>
      new Promise<object | undefined>((resolve) => {
        auth(resolve);
      });

    useAuthStore.getState().setAccessToken('first.token');
    const first = await handshake();
    useAuthStore.getState().setAccessToken('refreshed.token');
    const second = await handshake();

    expect([first, second]).toEqual([{ token: 'first.token' }, { token: 'refreshed.token' }]);
  });
});

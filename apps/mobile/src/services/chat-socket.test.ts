import { act } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import { TOKEN_REFRESH_PATH } from '../api/http';
import { useAuthStore } from '../store/useAuthStore';
import { errorBody } from '../test/api-fixtures';
import { FakeSocket } from '../test/fake-socket';
import { apiUrl, server, setupApiTestEnvironment } from '../test/msw';
import { createChatSocket, type ChatConnection, type SocketFactory } from './socket';

setupApiTestEnvironment();

/** The /chat socket shares the /orders token lifecycle (createAuthenticatedSocket). */
describe('/chat socket token lifecycle', () => {
  const REFRESH = 'stored.refresh.token';
  const RENEWED = 'renewed.access.token';
  const EXPIRED = 'expired.access.token';
  let fake: FakeSocket;
  let connection: ChatConnection | null = null;

  const factory: SocketFactory = (url, options) =>
    fake.created(url, options) as unknown as ReturnType<SocketFactory>;

  function serveRefresh(respond: () => Response) {
    let calls = 0;
    server.use(
      http.post(apiUrl(TOKEN_REFRESH_PATH), () => {
        calls += 1;
        return respond();
      }),
    );
    return { calls: () => calls };
  }

  const renewed = () =>
    HttpResponse.json({
      token_type: 'Bearer',
      access_token: RENEWED,
      access_token_expires_in: 900,
    });

  async function connect(): Promise<ChatConnection> {
    connection = createChatSocket(factory);
    connection.socket.connect();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    return connection;
  }

  beforeEach(() => {
    fake = new FakeSocket();
    jest.useFakeTimers();
  });

  afterEach(() => {
    connection?.close();
    connection = null;
    jest.useRealTimers();
  });

  it('targets /chat', async () => {
    serveRefresh(renewed);
    await connect();

    expect(fake.url).toBe('http://api.hamropasal.test/chat');
  });

  it('after a relaunch (no access token in memory) refreshes before the handshake', async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: REFRESH });
    const refresh = serveRefresh(renewed);
    fake.acceptToken = (token) => token === RENEWED;

    await connect();

    expect(fake.handshakes).toEqual([{ token: RENEWED }]);
    expect(fake.connected).toBe(true);
    expect(refresh.calls()).toBe(1);
  });

  it('renews a refused token and reconnects', async () => {
    useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
    serveRefresh(renewed);
    fake.acceptToken = (token) => token === RENEWED;

    await connect();

    expect(fake.handshakes).toEqual([{ token: EXPIRED }, { token: RENEWED }]);
    expect(fake.connected).toBe(true);
  });

  it('stays down and signs out when the refresh token is refused', async () => {
    useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
    serveRefresh(() => HttpResponse.json(errorBody('REFRESH_TOKEN_INVALID'), { status: 401 }));
    fake.acceptToken = () => false;

    await connect();

    expect(fake.handshakes).toEqual([{ token: EXPIRED }]);
    expect(fake.connected).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it('does not loop when a renewed token is refused too', async () => {
    useAuthStore.getState().setSession({ accessToken: EXPIRED, refreshToken: REFRESH });
    const refresh = serveRefresh(renewed);
    // Gives in after a few attempts so a regression fails instead of hanging.
    fake.acceptToken = () => fake.handshakes.length > 4;

    await connect();

    expect(fake.handshakes).toEqual([{ token: EXPIRED }, { token: RENEWED }]);
    expect(refresh.calls()).toBe(1);
  });

  it('never reconnects after close()', async () => {
    useAuthStore.setState({ accessToken: null, refreshToken: REFRESH });
    serveRefresh(() => HttpResponse.error());
    fake.acceptToken = (token) => token !== null;

    const chat = await connect();
    chat.close();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(fake.connectCalls).toBe(1);
  });
});

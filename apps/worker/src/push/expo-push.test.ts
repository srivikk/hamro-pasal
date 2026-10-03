import {
  EXPO_PUSH_BATCH_SIZE,
  ExpoPushGateway,
  PushDeliveryError,
  type ExpoPushMessage,
  type FetchLike,
} from './expo-push';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A stand-in for exp.host: records every request and answers with the queued responses. */
function fakeExpo(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) return Promise.reject(new Error('no response queued'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { calls, fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(call: Call | undefined): unknown {
  return JSON.parse(typeof call?.init.body === 'string' ? call.init.body : 'null') as unknown;
}

const message = (to: string): ExpoPushMessage => ({
  to,
  title: 'Order accepted',
  body: 'The shop is preparing order #1F8A11.',
  sound: 'default',
  priority: 'high',
  channelId: 'orders',
  data: { type: 'order.state_changed' },
});

describe('ExpoPushGateway', () => {
  it('POSTs the messages as a JSON array to the Expo push endpoint', async () => {
    const expo = fakeExpo(json({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    const gateway = new ExpoPushGateway({ fetch: expo.fetch });
    const sent = message('ExponentPushToken[aaa]');

    const tickets = await gateway.send([sent]);

    expect(expo.calls).toHaveLength(1);
    // The literal URL: the test must not take it from the constant it guards.
    expect(expo.calls[0]?.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(expo.calls[0]?.init.method).toBe('POST');
    const headers = new Headers(expo.calls[0]?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
    expect(bodyOf(expo.calls[0])).toEqual([sent]);
    expect(expo.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(tickets).toEqual([{ token: 'ExponentPushToken[aaa]', status: 'ok', id: 'ticket-1' }]);
  });

  it('sends EXPO_ACCESS_TOKEN as a bearer token when one is configured', async () => {
    const expo = fakeExpo(json({ data: [{ status: 'ok', id: 't' }] }));

    await new ExpoPushGateway({ fetch: expo.fetch, accessToken: 'expo-secret' }).send([
      message('ExponentPushToken[aaa]'),
    ]);

    expect(new Headers(expo.calls[0]?.init.headers).get('authorization')).toBe(
      'Bearer expo-secret',
    );
  });

  it('pairs each ticket with its token, including per-device errors', async () => {
    const expo = fakeExpo(
      json({
        data: [
          { status: 'ok', id: 'ticket-1' },
          {
            status: 'error',
            message: '"ExponentPushToken[bbb]" is not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'error', message: 'Something else' },
        ],
      }),
    );

    const tickets = await new ExpoPushGateway({ fetch: expo.fetch }).send([
      message('ExponentPushToken[aaa]'),
      message('ExponentPushToken[bbb]'),
      message('ExponentPushToken[ccc]'),
    ]);

    expect(tickets).toEqual([
      { token: 'ExponentPushToken[aaa]', status: 'ok', id: 'ticket-1' },
      {
        token: 'ExponentPushToken[bbb]',
        status: 'error',
        error: 'DeviceNotRegistered',
        message: '"ExponentPushToken[bbb]" is not a registered push notification recipient',
      },
      { token: 'ExponentPushToken[ccc]', status: 'error', error: null, message: 'Something else' },
    ]);
  });

  it('splits more than 100 messages into several requests, tickets kept in order', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => `ExponentPushToken[${String(i)}]`);
    const ok = (count: number, from: number) =>
      json({
        data: Array.from({ length: count }, (_, i) => ({ status: 'ok', id: String(from + i) })),
      });
    const expo = fakeExpo(ok(100, 0), ok(50, 100));

    const tickets = await new ExpoPushGateway({ fetch: expo.fetch }).send(tokens.map(message));

    expect(EXPO_PUSH_BATCH_SIZE).toBe(100);
    expect(expo.calls.map((call) => (bodyOf(call) as unknown[]).length)).toEqual([100, 50]);
    expect(tickets.map((ticket) => ticket.token)).toEqual(tokens);
    expect(tickets[149]).toEqual({ token: tokens[149], status: 'ok', id: '149' });
  });

  it('makes no request for no messages', async () => {
    const expo = fakeExpo();

    expect(await new ExpoPushGateway({ fetch: expo.fetch }).send([])).toEqual([]);
    expect(expo.calls).toEqual([]);
  });

  it.each([
    ['an HTTP error', json({ errors: [{ code: 'TOO_MANY_REQUESTS' }] }, 429), 'HTTP 429'],
    ['a network failure', new TypeError('fetch failed'), 'fetch failed'],
    ['a body that is not JSON', new Response('<html>', { status: 200 }), 'unexpected response'],
    ['a body without tickets', json({ ok: true }), 'unexpected response'],
    ['fewer tickets than messages', json({ data: [] }), 'unexpected response'],
  ])('throws PushDeliveryError on %s', async (_name, response, expected) => {
    const gateway = new ExpoPushGateway({ fetch: fakeExpo(response).fetch });

    const failure = gateway.send([message('ExponentPushToken[aaa]')]);

    await expect(failure).rejects.toBeInstanceOf(PushDeliveryError);
    await expect(failure).rejects.toThrow(expected);
  });
});

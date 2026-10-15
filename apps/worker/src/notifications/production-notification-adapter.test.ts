import { randomUUID } from 'node:crypto';

import type { ServerEnv } from '@hamro-pasal/shared-types';
import { SmsDeliveryError, SparrowSmsGateway, type FetchLike } from '@hamro-pasal/sms';

import { EXPO_PUSH_SEND_URL, ExpoPushGateway } from '../push/expo-push';
import { LoggerNotificationAdapter, type VendorNotice } from './notification-adapter';
import {
  notificationAdapterFromEnv,
  noticePushMessages,
  ProductionNotificationAdapter,
  type NoticePushOutcome,
} from './production-notification-adapter';
import type { PushRecipient } from './push-recipients';

const SPARROW_URL = 'https://api.sparrowsms.test/v2/sms/';
const PHONE = '+9779800000011';
const TOKENS = [
  'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
  'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]',
];

function noticeOf(overrides: Partial<VendorNotice> = {}): VendorNotice {
  return {
    eventId: randomUUID(),
    eventType: 'vendor.suspended_for_compliance',
    vendorId: randomUUID(),
    phone: PHONE,
    sms: 'Hamro Pasal: your shop is offline because no PAN is on file.',
    push: { title: 'Your shop is offline', body: 'Please add your PAN in Shop settings.' },
    ...overrides,
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that never answers until the request's own timeout aborts it, as a hung provider does. */
const hangs: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    const abort = () => {
      reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
    };
    if (init.signal?.aborted === true) abort();
    else init.signal?.addEventListener('abort', abort);
  });

/** The real Sparrow and Expo gateways over recording fetches, and a shop with `tokens`. */
function harness(
  options: {
    tokens?: readonly string[] | null;
    smsFetch?: FetchLike;
    pushFetch?: FetchLike;
    recipients?: { vendor: () => Promise<PushRecipient | null>; remove: () => Promise<void> };
  } = {},
) {
  const smsCalls: Call[] = [];
  const pushCalls: Call[] = [];
  const removed: string[][] = [];
  const outcomes: NoticePushOutcome[] = [];
  const tokens = options.tokens === undefined ? TOKENS : options.tokens;

  const smsFetch: FetchLike = (url, init) => {
    smsCalls.push({ url, init });
    return (options.smsFetch ?? (() => Promise.resolve(json({ response_code: 200 }))))(url, init);
  };
  const pushFetch = (url: string, init: RequestInit) => {
    pushCalls.push({ url, init });
    if (options.pushFetch !== undefined) return options.pushFetch(url, init);
    const sent = JSON.parse(bodyOf(init)) as unknown[];
    return Promise.resolve(
      json({ data: sent.map((_, i) => ({ status: 'ok', id: `t-${String(i)}` })) }),
    );
  };

  const adapter = new ProductionNotificationAdapter({
    sms: new SparrowSmsGateway({ token: 'tok', from: 'HamroPasal', apiUrl: SPARROW_URL }, smsFetch),
    push: new ExpoPushGateway({ fetch: pushFetch, timeoutMs: 40 }),
    recipients: options.recipients ?? {
      vendor: (vendorId: string) =>
        Promise.resolve(
          tokens === null ? null : { userId: `user-of-${vendorId}`, phone: PHONE, tokens },
        ),
      remove: (gone: readonly string[]) => {
        removed.push([...gone]);
        return Promise.resolve();
      },
    },
    onPushOutcome: (_notice, outcome) => outcomes.push(outcome),
  });
  return { adapter, smsCalls, pushCalls, removed, outcomes };
}

describe('ProductionNotificationAdapter', () => {
  it('posts the SMS to the SMS provider and the push to Expo, for every device of the shop', async () => {
    const { adapter, smsCalls, pushCalls, outcomes } = harness();
    const notice = noticeOf();

    await adapter.send(notice);

    expect(adapter.name).toBe('SPARROW');
    expect(smsCalls).toHaveLength(1);
    expect(smsCalls[0]?.url).toBe(SPARROW_URL);
    expect(Object.fromEntries(new URLSearchParams(bodyOf(smsCalls[0]?.init)))).toEqual({
      token: 'tok',
      from: 'HamroPasal',
      to: PHONE,
      text: notice.sms,
    });

    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]?.url).toBe(EXPO_PUSH_SEND_URL);
    expect(JSON.parse(bodyOf(pushCalls[0]?.init))).toEqual(
      TOKENS.map((to) => ({
        to,
        title: 'Your shop is offline',
        body: 'Please add your PAN in Shop settings.',
        sound: 'default',
        priority: 'high',
        channelId: 'orders',
        data: {
          type: 'vendor.notice',
          notification_id: `${notice.eventId}:${notice.vendorId}`,
          event_type: 'vendor.suspended_for_compliance',
        },
      })),
    );
    expect(outcomes).toEqual([
      { notification: 'notice.push_sent', sent: 2, rejected: 0, removed_tokens: 0 },
    ]);
  });

  it('sends the SMS alone when the shop has no device, or is not found', async () => {
    for (const tokens of [[], null]) {
      const { adapter, smsCalls, pushCalls, outcomes } = harness({ tokens });

      await adapter.send(noticeOf());

      expect(smsCalls).toHaveLength(1);
      expect(pushCalls).toEqual([]);
      expect(outcomes).toEqual([{ notification: 'notice.push_skipped', reason: 'NO_DEVICE' }]);
    }
  });

  it('rejects when the SMS provider refuses, and sends no push before the SMS is accepted', async () => {
    const refusals: FetchLike[] = [
      () => Promise.resolve(json({ response_code: 1002 })),
      () => Promise.resolve(json({}, 503)),
      () => Promise.reject(new TypeError('fetch failed')),
    ];
    for (const smsFetch of refusals) {
      const { adapter, pushCalls, outcomes } = harness({ smsFetch });

      await expect(adapter.send(noticeOf())).rejects.toBeInstanceOf(SmsDeliveryError);

      // A retry will send the SMS again: the push waits for it, so it is never repeated.
      expect(pushCalls).toEqual([]);
      expect(outcomes).toEqual([]);
    }
  });

  it('rejects with a delivery error when the SMS provider times out', async () => {
    const sms = new SparrowSmsGateway(
      { token: 'tok', from: 'HamroPasal', apiUrl: SPARROW_URL },
      hangs,
    );
    // The gateway's own timeout is 10 s; the abort is what a timeout looks like to the adapter.
    const timeout = jest
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => AbortSignal.abort(new DOMException('timed out', 'TimeoutError')));
    const adapter = new ProductionNotificationAdapter({
      sms,
      push: { send: () => Promise.reject(new Error('must not be reached')) },
      recipients: { vendor: () => Promise.resolve(null), remove: () => Promise.resolve() },
      onPushOutcome: () => undefined,
    });

    await expect(adapter.send(noticeOf())).rejects.toThrow('SPARROW SMS failed');
    timeout.mockRestore();
  });

  it('does not fail the notice when Expo times out, errors or answers nonsense: it is tracked', async () => {
    const failures: [FetchLike, RegExp][] = [
      [hangs, /Expo push request failed/],
      [() => Promise.resolve(json({}, 502)), /HTTP 502/],
      [() => Promise.resolve(new Response('<html>')), /unexpected response body/],
      [() => Promise.reject(new TypeError('fetch failed')), /fetch failed/],
    ];
    for (const [pushFetch, message] of failures) {
      const { adapter, smsCalls, pushCalls, outcomes } = harness({ pushFetch });

      await expect(adapter.send(noticeOf())).resolves.toBeUndefined();

      expect(smsCalls).toHaveLength(1);
      // Best effort: one attempt, no retry inside the adapter.
      expect(pushCalls).toHaveLength(1);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ notification: 'notice.push_failed' });
      expect((outcomes[0] as { error: string }).error).toMatch(message);
    }
  });

  it('does not fail the notice when the device tokens cannot be read', async () => {
    const { adapter, smsCalls, pushCalls, outcomes } = harness({
      recipients: {
        vendor: () => Promise.reject(new Error('connection terminated')),
        remove: () => Promise.resolve(),
      },
    });

    await expect(adapter.send(noticeOf())).resolves.toBeUndefined();

    expect(smsCalls).toHaveLength(1);
    expect(pushCalls).toEqual([]);
    expect(outcomes).toEqual([
      { notification: 'notice.push_failed', error: 'connection terminated' },
    ]);
  });

  it('forgets a device Expo no longer knows, and counts the refusals', async () => {
    const { adapter, removed, outcomes } = harness({
      pushFetch: () =>
        Promise.resolve(
          json({
            data: [
              { status: 'ok', id: 't-1' },
              {
                status: 'error',
                message: 'not registered',
                details: { error: 'DeviceNotRegistered' },
              },
            ],
          }),
        ),
    });

    await adapter.send(noticeOf());

    expect(removed).toEqual([[TOKENS[1]]]);
    expect(outcomes).toEqual([
      { notification: 'notice.push_sent', sent: 1, rejected: 1, removed_tokens: 1 },
    ]);
  });

  it('keeps the notice delivered when forgetting a token or reporting the push fails', async () => {
    const adapter = new ProductionNotificationAdapter({
      sms: { provider: 'AAKASH', send: () => Promise.resolve({ provider: 'AAKASH', to: PHONE }) },
      push: {
        send: (messages) =>
          Promise.resolve(
            messages.map((message) => ({
              token: message.to,
              status: 'error' as const,
              error: 'DeviceNotRegistered',
              message: 'gone',
            })),
          ),
      },
      recipients: {
        vendor: () => Promise.resolve({ userId: 'u', phone: PHONE, tokens: TOKENS }),
        remove: () => Promise.reject(new Error('database down')),
      },
      onPushOutcome: () => {
        throw new Error('logger broke');
      },
    });

    await expect(adapter.send(noticeOf())).resolves.toBeUndefined();
    expect(adapter.name).toBe('AAKASH');
  });

  it('logs one JSON line per push by default, without the phone, the text or a token', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const notice = noticeOf();
    const build = (pushOk: boolean) =>
      new ProductionNotificationAdapter({
        sms: {
          provider: 'SPARROW',
          send: () => Promise.resolve({ provider: 'SPARROW', to: PHONE }),
        },
        push: {
          send: (messages) =>
            pushOk
              ? Promise.resolve(
                  messages.map((m) => ({ token: m.to, status: 'ok' as const, id: 'x' })),
                )
              : Promise.reject(new Error('Expo push request failed: HTTP 500')),
        },
        recipients: {
          vendor: () => Promise.resolve({ userId: 'u', phone: PHONE, tokens: TOKENS }),
          remove: () => Promise.resolve(),
        },
      });

    await build(true).send(notice);
    await build(false).send(notice);

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      notification: 'notice.push_sent',
      sent: 2,
      rejected: 0,
      removed_tokens: 0,
      event_type: notice.eventType,
      event_id: notice.eventId,
      vendor_id: notice.vendorId,
    });
    const failed = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(failed)).toMatchObject({
      notification: 'notice.push_failed',
      error: 'Expo push request failed: HTTP 500',
      vendor_id: notice.vendorId,
    });
    for (const line of [String(info.mock.calls[0]?.[0]), failed]) {
      expect(line).not.toContain(PHONE);
      expect(line).not.toContain('ExponentPushToken');
      expect(line).not.toContain(notice.sms);
    }
    info.mockRestore();
    error.mockRestore();
  });
});

describe('noticePushMessages', () => {
  it('is one visible, high-priority message per device', () => {
    const notice = noticeOf();
    const messages = noticePushMessages(notice, TOKENS);
    expect(messages.map((message) => message.to)).toEqual(TOKENS);
    for (const message of messages) {
      expect(message).toMatchObject({ title: notice.push.title, body: notice.push.body });
      expect(message._contentAvailable).toBeUndefined();
    }
    expect(noticePushMessages(notice, [])).toEqual([]);
  });
});

describe('notificationAdapterFromEnv', () => {
  const deps = {
    sms: { provider: 'SPARROW' as const, send: () => Promise.reject(new Error('unused')) },
    push: { send: () => Promise.resolve([]) },
    recipients: { vendor: () => Promise.resolve(null), remove: () => Promise.resolve() },
  };
  const env = (MOCK_SERVICES: boolean, NODE_ENV: ServerEnv['NODE_ENV']) => ({
    MOCK_SERVICES,
    NODE_ENV,
  });

  it('is the real adapter unless MOCK_SERVICES is on, and always in production', () => {
    expect(notificationAdapterFromEnv(env(false, 'development'), deps)).toBeInstanceOf(
      ProductionNotificationAdapter,
    );
    expect(notificationAdapterFromEnv(env(false, 'production'), deps)).toBeInstanceOf(
      ProductionNotificationAdapter,
    );
    expect(notificationAdapterFromEnv(env(true, 'production'), deps)).toBeInstanceOf(
      ProductionNotificationAdapter,
    );
    expect(notificationAdapterFromEnv(env(true, 'development'), deps)).toBeInstanceOf(
      LoggerNotificationAdapter,
    );
  });
});

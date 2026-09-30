import { mockSmsLogLine, smsGatewayFromEnv, type SmsEnv } from './from-env';
import { MockSmsGateway, type FetchLike } from './sms-gateway';

const none = {
  SPARROW_SMS_TOKEN: undefined,
  SPARROW_SMS_FROM: undefined,
  SPARROW_SMS_API_URL: undefined,
  AAKASH_SMS_AUTH_TOKEN: undefined,
  AAKASH_SMS_API_URL: undefined,
} as const;

function recordingFetch() {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, form: new URLSearchParams(typeof init.body === 'string' ? init.body : '') });
    return Promise.resolve(new Response(JSON.stringify({ response_code: 200 }), { status: 200 }));
  };
  return { calls, fetchImpl };
}

describe('smsGatewayFromEnv', () => {
  it('MOCK logs the message and makes no network call', async () => {
    const lines: string[] = [];
    const { calls, fetchImpl } = recordingFetch();
    const gateway = smsGatewayFromEnv(
      { ...none, SMS_PROVIDER: 'MOCK' },
      { mockLog: (line) => lines.push(line), fetch: fetchImpl },
    );

    const delivery = await gateway.send({ to: '9812345678', text: 'Hamro Pasal: hello' });

    expect(gateway).toBeInstanceOf(MockSmsGateway);
    expect(delivery).toEqual({ provider: 'MOCK', to: '+9779812345678' });
    expect(lines).toEqual(['[sms:mock] to +9779812345678: Hamro Pasal: hello']);
    expect(calls).toEqual([]);
  });

  it('MOCK prints to console.info by default', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await smsGatewayFromEnv({ ...none, SMS_PROVIDER: 'MOCK' }).send({
        to: '+9779812345678',
        text: 'Hamro Pasal: hi',
      });
      expect(info).toHaveBeenCalledWith('[sms:mock] to +9779812345678: Hamro Pasal: hi');
    } finally {
      info.mockRestore();
    }
  });

  it('SPARROW posts token, from, to and text to the configured URL', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const env: SmsEnv = {
      ...none,
      SMS_PROVIDER: 'SPARROW',
      SPARROW_SMS_TOKEN: 'tok',
      SPARROW_SMS_FROM: 'HamroPasal',
      SPARROW_SMS_API_URL: 'https://sparrow.test/v2/sms/',
    };

    const delivery = await smsGatewayFromEnv(env, { fetch: fetchImpl }).send({
      to: '9812345678',
      text: 'Hamro Pasal: hi',
    });

    expect(delivery.provider).toBe('SPARROW');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://sparrow.test/v2/sms/');
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      token: 'tok',
      from: 'HamroPasal',
      to: '+9779812345678',
      text: 'Hamro Pasal: hi',
    });
  });

  it('AAKASH builds the Aakash adapter', () => {
    const gateway = smsGatewayFromEnv({
      ...none,
      SMS_PROVIDER: 'AAKASH',
      AAKASH_SMS_AUTH_TOKEN: 'a',
      AAKASH_SMS_API_URL: 'https://aakash.test/',
    });
    expect(gateway.provider).toBe('AAKASH');
  });

  it('refuses FIREBASE and missing Sparrow credentials', () => {
    expect(() => smsGatewayFromEnv({ ...none, SMS_PROVIDER: 'FIREBASE' })).toThrow(/FIREBASE/);
    expect(() => smsGatewayFromEnv({ ...none, SMS_PROVIDER: 'SPARROW' })).toThrow(
      /SPARROW_SMS_TOKEN/,
    );
  });

  it('mockSmsLogLine formats recipient and text', () => {
    expect(mockSmsLogLine({ to: '+9779800000011', text: 'x' })).toBe(
      '[sms:mock] to +9779800000011: x',
    );
  });
});

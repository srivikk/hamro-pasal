import { InvalidNepalPhoneError, NEPAL_PHONE_REGEX } from '@hamro-pasal/shared-types';

import {
  AakashSmsGateway,
  MockSmsGateway,
  prepareOutboundSms,
  SmsDeliveryError,
  SparrowSmsGateway,
  type FetchLike,
} from './sms-gateway';

function recordingFetch(body: unknown, status = 200) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, form: new URLSearchParams(typeof init.body === 'string' ? init.body : '') });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { calls, fetchImpl };
}

describe('prepareOutboundSms', () => {
  it.each(['9812345678', '+977 981-234-5678', '009779812345678', '977-9812345678'])(
    'formats %s as strict +977',
    (to) => {
      const sms = prepareOutboundSms({ to, text: 'Your Hamro Pasal OTP is 4821' });

      expect(sms.to).toBe('+9779812345678');
      expect(NEPAL_PHONE_REGEX.test(sms.to)).toBe(true);
    },
  );

  it.each(['+919812345678', '+18005550100', '12345', 'not a phone'])(
    'refuses to address %s',
    (to) => {
      expect(() => prepareOutboundSms({ to, text: 'hi' })).toThrow(InvalidNepalPhoneError);
    },
  );

  it('rejects empty and oversized texts', () => {
    expect(() => prepareOutboundSms({ to: '9812345678', text: '   ' })).toThrow(RangeError);
    expect(() => prepareOutboundSms({ to: '9812345678', text: 'x'.repeat(336) })).toThrow(
      RangeError,
    );
  });
});

describe('SparrowSmsGateway', () => {
  const config = {
    token: 'sparrow-token',
    from: 'HamroPasal',
    apiUrl: 'https://api.sparrowsms.com/v2/sms/',
  };

  it('posts token, from, +977 recipient and text', async () => {
    const { calls, fetchImpl } = recordingFetch({ response_code: 200, count: 1 });

    const delivery = await new SparrowSmsGateway(config, fetchImpl).send({
      to: '9812345678',
      text: 'तपाईंको OTP ४८२१ हो',
    });

    expect(delivery).toEqual({ provider: 'SPARROW', to: '+9779812345678' });
    expect(calls[0]?.url).toBe(config.apiUrl);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      token: 'sparrow-token',
      from: 'HamroPasal',
      to: '+9779812345678',
      text: 'तपाईंको OTP ४८२१ हो',
    });
  });

  it('treats a non-200 response_code as a failed delivery', async () => {
    const { fetchImpl } = recordingFetch({ response_code: 1002, response: 'Invalid Token' });

    await expect(
      new SparrowSmsGateway(config, fetchImpl).send({ to: '9812345678', text: 'hi' }),
    ).rejects.toBeInstanceOf(SmsDeliveryError);
  });

  it('never calls the provider for an invalid recipient', async () => {
    const { calls, fetchImpl } = recordingFetch({ response_code: 200 });

    await expect(
      new SparrowSmsGateway(config, fetchImpl).send({ to: '+919812345678', text: 'hi' }),
    ).rejects.toBeInstanceOf(InvalidNepalPhoneError);
    expect(calls).toHaveLength(0);
  });
});

describe('AakashSmsGateway', () => {
  const config = { authToken: 'aakash-token', apiUrl: 'https://sms.aakashsms.com/sms/v3/send' };

  it('posts auth_token, +977 recipient and text', async () => {
    const { calls, fetchImpl } = recordingFetch({ error: false, message: '1 message sent' });

    await new AakashSmsGateway(config, fetchImpl).send({ to: '+977 9701234567', text: 'hello' });

    expect(Object.fromEntries(calls[0]?.form ?? [])).toEqual({
      auth_token: 'aakash-token',
      to: '+9779701234567',
      text: 'hello',
    });
  });

  it('surfaces provider and HTTP failures as SmsDeliveryError', async () => {
    for (const [body, status] of [
      [{ error: true, message: 'Invalid auth token' }, 200],
      [{ error: false }, 500],
    ] as const) {
      const { fetchImpl } = recordingFetch(body, status);
      await expect(
        new AakashSmsGateway(config, fetchImpl).send({ to: '9812345678', text: 'hi' }),
      ).rejects.toBeInstanceOf(SmsDeliveryError);
    }
  });
});

describe('MockSmsGateway', () => {
  it('records only strictly formatted messages', async () => {
    const gateway = new MockSmsGateway();

    await gateway.send({ to: '98-1234-5678', text: 'OTP 1234' });
    await expect(gateway.send({ to: '+441234567890', text: 'x' })).rejects.toThrow();

    expect(gateway.sent).toEqual([{ to: '+9779812345678', text: 'OTP 1234' }]);
  });
});

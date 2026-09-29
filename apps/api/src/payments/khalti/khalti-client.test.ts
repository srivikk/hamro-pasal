import { PaymentGatewayError, type FetchLike } from '../gateway-http';
import { KhaltiClient } from './khalti-client';

const bodyText = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

const config = {
  secretKey: 'live_secret_key_test',
  baseUrl: 'https://a.khalti.com/api/v2/',
  returnUrl: 'https://app.hamropasal.test/khalti/return',
  websiteUrl: 'https://hamropasal.test',
};

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  };
  return { calls, fetchImpl };
}

describe('KhaltiClient', () => {
  it('initiates at the SPEC endpoint with Key auth and the amount in paisa', async () => {
    const { calls, fetchImpl } = fakeFetch(200, {
      pidx: 'bZQLD9wRVWo4CdESSfuSsB',
      payment_url: 'https://test-pay.khalti.com/?pidx=bZQLD9wRVWo4CdESSfuSsB',
      expires_at: '2026-09-29T11:00:00+05:45',
      expires_in: 1800,
    });

    const result = await new KhaltiClient(config, fetchImpl).initiate({
      amountPaisa: 105_050,
      purchaseOrderId: 'order-1',
      purchaseOrderName: 'Hamro Pasal order',
    });

    expect(result.pidx).toBe('bZQLD9wRVWo4CdESSfuSsB');
    const [call] = calls;
    expect(call?.url).toBe('https://a.khalti.com/api/v2/epayment/initiate/');
    expect(new Headers(call?.init.headers).get('authorization')).toBe('Key live_secret_key_test');
    expect(JSON.parse(bodyText(call?.init))).toEqual({
      return_url: config.returnUrl,
      website_url: config.websiteUrl,
      amount: 105050,
      purchase_order_id: 'order-1',
      purchase_order_name: 'Hamro Pasal order',
    });
  });

  it('refuses fractional or non-positive paisa before calling Khalti', () => {
    const { calls, fetchImpl } = fakeFetch(200, {});
    const client = new KhaltiClient(config, fetchImpl);

    expect(() =>
      client.initiate({ amountPaisa: 1050.5, purchaseOrderId: 'o', purchaseOrderName: 'n' }),
    ).toThrow('whole number of paisa');
    expect(() =>
      client.initiate({ amountPaisa: 0, purchaseOrderId: 'o', purchaseOrderName: 'n' }),
    ).toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('looks up a pidx and returns the paisa amount and status', async () => {
    const { calls, fetchImpl } = fakeFetch(200, {
      pidx: 'abc',
      total_amount: 105050,
      status: 'Completed',
      transaction_id: 'GFq9PFS7b2iYvL8Lir9oXe',
      fee: 0,
      refunded: false,
    });

    const result = await new KhaltiClient(config, fetchImpl).lookup('abc');

    expect(result).toMatchObject({ total_amount: 105050, status: 'Completed' });
    expect(calls[0]?.url).toBe('https://a.khalti.com/api/v2/epayment/lookup/');
    expect(JSON.parse(bodyText(calls[0]?.init))).toEqual({ pidx: 'abc' });
  });

  it('turns HTTP errors, garbage and unexpected shapes into PaymentGatewayError', async () => {
    const cases: [number, unknown][] = [
      [401, { detail: 'Invalid token.' }],
      [200, 'not json'],
      [200, { pidx: 'abc' }],
    ];
    for (const [status, body] of cases) {
      const { fetchImpl } = fakeFetch(status, body);
      await expect(new KhaltiClient(config, fetchImpl).lookup('abc')).rejects.toBeInstanceOf(
        PaymentGatewayError,
      );
    }
  });

  it('reports network failures as PaymentGatewayError', async () => {
    const failing: FetchLike = () => Promise.reject(new Error('ECONNRESET'));

    await expect(new KhaltiClient(config, failing).lookup('abc')).rejects.toThrow('ECONNRESET');
  });
});

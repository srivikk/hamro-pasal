import type { PaymentTarget } from './payment-redirect';
import {
  buildEsewaFormHtml,
  escapeHtml,
  esewaTarget,
  interpretNavigation,
  khaltiStatusNeedsLookup,
  khaltiTarget,
  PaymentTargetError,
  rawQueryParam,
} from './payment-redirect';

const ORDER_ID = '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c';

// Shape of POST /api/payments/esewa/initiate (apps/api esewa-service: signed request fields).
const ESEWA_INITIATE = {
  payment_url: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
  method: 'POST' as const,
  fields: {
    amount: '1150',
    tax_amount: '0',
    product_service_charge: '0',
    product_delivery_charge: '50',
    total_amount: '1200',
    transaction_uuid: '9d2f7a4e-1b3c-4d5e-8f6a-7b8c9d0e1f2a',
    product_code: 'EPAYTEST',
    success_url: 'https://api.hamropasal.test/payments/esewa/success',
    failure_url: 'https://api.hamropasal.test/payments/esewa/failure',
    signed_field_names: 'total_amount,transaction_uuid,product_code',
    signature: 'i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=',
  },
};

const KHALTI_INITIATE = {
  pidx: 'bZQLD9wRVWo4CdESSfuSsB',
  payment_url: 'https://test-pay.khalti.com/?pidx=bZQLD9wRVWo4CdESSfuSsB',
  expires_at: '2026-09-29T10:30:00+05:45',
};

const esewa: PaymentTarget = esewaTarget(ORDER_ID, ESEWA_INITIATE);
const khalti: PaymentTarget = khaltiTarget(ORDER_ID, KHALTI_INITIATE);

/** A realistic eSewa success payload: base64 with `+`, `/` and `=` padding. */
const ESEWA_DATA =
  'eyJ0cmFuc2FjdGlvbl9jb2RlIjoiMDAwQVdFTyIsInN0YXR1cyI6IkNPTVBMRVRFIiwidG90YWxfYW1vdW50IjoxMDAwLjB+/9==';

describe('buildEsewaFormHtml', () => {
  it('auto-submits a POST form to payment_url with every signed field', () => {
    const html = buildEsewaFormHtml(ESEWA_INITIATE.payment_url, ESEWA_INITIATE.fields);

    expect(html).toContain('<body onload="document.forms[0].submit()">');
    expect(html).toContain(
      '<form method="POST" action="https://rc-epay.esewa.com.np/api/epay/main/v2/form">',
    );
    for (const [name, value] of Object.entries(ESEWA_INITIATE.fields)) {
      expect(html).toContain(`<input type="hidden" name="${name}" value="${value}" />`);
    }
  });

  it('escapes values, so a field can never inject markup or script', () => {
    const html = buildEsewaFormHtml('https://pay.test/"><script>alert(1)</script>', {
      note: `"/><script>alert('x')</script>`,
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('value="&quot;/&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"');
  });

  it('escapeHtml covers the five HTML metacharacters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('payment targets', () => {
  it('builds the eSewa target from the signed fields', () => {
    expect(esewa).toMatchObject({
      method: 'ESEWA',
      orderId: ORDER_ID,
      successUrl: 'https://api.hamropasal.test/payments/esewa/success',
      failureUrl: 'https://api.hamropasal.test/payments/esewa/failure',
    });
  });

  it('builds the Khalti target from pidx and payment_url', () => {
    expect(khalti).toEqual({
      method: 'KHALTI',
      orderId: ORDER_ID,
      pidx: KHALTI_INITIATE.pidx,
      paymentUrl: KHALTI_INITIATE.payment_url,
    });
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/hosts'])(
    'refuses to load or post to %p',
    (url) => {
      expect(() => esewaTarget(ORDER_ID, { ...ESEWA_INITIATE, payment_url: url })).toThrow(
        PaymentTargetError,
      );
      expect(() => khaltiTarget(ORDER_ID, { ...KHALTI_INITIATE, payment_url: url })).toThrow(
        PaymentTargetError,
      );
    },
  );

  it('refuses eSewa fields without callback URLs', () => {
    const { success_url: _dropped, ...fields } = ESEWA_INITIATE.fields;

    expect(() => esewaTarget(ORDER_ID, { ...ESEWA_INITIATE, fields })).toThrow(PaymentTargetError);
  });
});

describe('interpretNavigation: eSewa', () => {
  it('ignores the injected form page and eSewa pages', () => {
    for (const url of [
      'about:blank',
      'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
      'https://rc-epay.esewa.com.np/login?next=/payment',
    ]) {
      expect(interpretNavigation(esewa, url)).toEqual({ kind: 'none' });
    }
  });

  it('extracts `data` verbatim from the success redirect', () => {
    expect(
      interpretNavigation(
        esewa,
        `https://api.hamropasal.test/payments/esewa/success?data=${ESEWA_DATA}`,
      ),
    ).toEqual({ kind: 'esewa_success', data: ESEWA_DATA });
  });

  it('keeps `+` as `+` (URLSearchParams would turn it into a space and break the signature)', () => {
    const redirect = interpretNavigation(
      esewa,
      'https://api.hamropasal.test/payments/esewa/success?data=ab+cd/ef==',
    );

    expect(redirect).toEqual({ kind: 'esewa_success', data: 'ab+cd/ef==' });
  });

  it('undoes percent-encoding added in transit', () => {
    expect(
      interpretNavigation(
        esewa,
        'https://api.hamropasal.test/payments/esewa/success?data=ab%2Bcd%3D%3D',
      ),
    ).toEqual({ kind: 'esewa_success', data: 'ab+cd==' });
  });

  it('matches regardless of trailing slash, host case, other params and fragments', () => {
    expect(
      interpretNavigation(
        esewa,
        'https://API.hamropasal.test/payments/esewa/success/?utm=1&data=abc=#top',
      ),
    ).toEqual({ kind: 'esewa_success', data: 'abc=' });
  });

  it('treats a success redirect without data as a failure', () => {
    expect(
      interpretNavigation(esewa, 'https://api.hamropasal.test/payments/esewa/success'),
    ).toEqual({
      kind: 'failure',
    });
  });

  it('recognises the failure redirect, with or without query', () => {
    expect(
      interpretNavigation(esewa, 'https://api.hamropasal.test/payments/esewa/failure'),
    ).toEqual({
      kind: 'failure',
    });
    expect(
      interpretNavigation(esewa, 'https://api.hamropasal.test/payments/esewa/failure?data=x'),
    ).toEqual({ kind: 'failure' });
  });

  it('never matches by substring', () => {
    for (const url of [
      'https://evil.test/?next=https://api.hamropasal.test/payments/esewa/success&data=abc',
      'https://api.hamropasal.test/payments/esewa/success-page?data=abc',
      'https://api.hamropasal.test.evil.test/payments/esewa/success?data=abc',
      'http://api.hamropasal.test/payments/esewa/success?data=abc',
    ]) {
      expect(interpretNavigation(esewa, url)).toEqual({ kind: 'none' });
    }
  });
});

describe('interpretNavigation: Khalti', () => {
  const RETURN = 'https://api.hamropasal.test/payments/khalti/return';

  it('ignores Khalti pages, even though they carry the pidx', () => {
    expect(interpretNavigation(khalti, KHALTI_INITIATE.payment_url)).toEqual({ kind: 'none' });
    expect(
      interpretNavigation(
        khalti,
        `https://test-pay.khalti.com/confirm?pidx=${KHALTI_INITIATE.pidx}`,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('recognises the return_url redirect for this pidx with its status', () => {
    const url = `${RETURN}?pidx=${KHALTI_INITIATE.pidx}&transaction_id=GFq9PFS7b2iYvL8Lir9oXe&amount=120000&status=Completed&purchase_order_id=${ORDER_ID}`;

    expect(interpretNavigation(khalti, url)).toEqual({
      kind: 'khalti_return',
      pidx: KHALTI_INITIATE.pidx,
      status: 'Completed',
    });
  });

  it('decodes a status with spaces', () => {
    expect(
      interpretNavigation(khalti, `${RETURN}?pidx=${KHALTI_INITIATE.pidx}&status=User%20canceled`),
    ).toMatchObject({ kind: 'khalti_return', status: 'User canceled' });
  });

  it("ignores a return for another payment's pidx", () => {
    expect(interpretNavigation(khalti, `${RETURN}?pidx=someOtherPidx&status=Completed`)).toEqual({
      kind: 'none',
    });
  });

  it('only looks up statuses that can be paid', () => {
    expect(khaltiStatusNeedsLookup('Completed')).toBe(true);
    expect(khaltiStatusNeedsLookup('Pending')).toBe(true);
    expect(khaltiStatusNeedsLookup(null)).toBe(true);
    expect(khaltiStatusNeedsLookup('User canceled')).toBe(false);
    expect(khaltiStatusNeedsLookup('Expired')).toBe(false);
  });
});

describe('rawQueryParam', () => {
  it('returns the first matching value, or null', () => {
    expect(rawQueryParam('https://x.test/?a=1&b=2&a=3', 'a')).toBe('1');
    expect(rawQueryParam('https://x.test/?a=1', 'b')).toBeNull();
    expect(rawQueryParam('https://x.test/', 'a')).toBeNull();
    expect(rawQueryParam('https://x.test/?flag', 'flag')).toBe('');
  });

  it('keeps a malformed escape as-is instead of throwing', () => {
    expect(rawQueryParam('https://x.test/?a=100%', 'a')).toBe('100%');
  });
});

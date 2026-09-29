import {
  decodeEsewaCallback,
  esewaHmacBase64,
  esewaSignatureMessage,
  signEsewaRequest,
  verifyEsewaCallbackSignature,
} from './signature';

/** eSewa's public UAT secret key for product code EPAYTEST (from the ePay v2 docs). */
const UAT_SECRET = '8gBm/:&EnhH.1/q';

/** eSewa's documented success callback (decoded `data`), including its signature. */
const DOCUMENTED_CALLBACK_JSON =
  '{"transaction_code":"000AWEO","status":"COMPLETE","total_amount":1000.0,' +
  '"transaction_uuid":"250610-162413","product_code":"EPAYTEST",' +
  '"signed_field_names":"transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names",' +
  '"signature":"62GcfZTmVkzhtUeh+QJ1AqiJrjoWWGof3U+eTPTZ7fA="}';

const toBase64 = (json: string) => Buffer.from(json, 'utf8').toString('base64');

describe('eSewa request signature (HMAC-SHA256 -> Base64)', () => {
  it('matches eSewa’s published request test vector', () => {
    expect(
      signEsewaRequest(
        { total_amount: '110', transaction_uuid: '241028', product_code: 'EPAYTEST' },
        UAT_SECRET,
      ),
    ).toBe('i94zsd3oXF6ZsSr/kGqT4sSzYQzjj1W/waxjWyRwaME=');
  });

  it('signs "name=value" pairs in signed_field_names order', () => {
    expect(
      esewaSignatureMessage(
        { product_code: 'EPAYTEST', total_amount: '110', transaction_uuid: '241028' },
        ['total_amount', 'transaction_uuid', 'product_code'],
      ),
    ).toBe('total_amount=110,transaction_uuid=241028,product_code=EPAYTEST');
  });

  it('outputs standard Base64 of a 32-byte digest', () => {
    const signature = esewaHmacBase64('any message', UAT_SECRET);

    expect(signature).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(signature, 'base64')).toHaveLength(32);
  });

  it('changes when any signed value or the secret changes', () => {
    const base = { total_amount: '110', transaction_uuid: '241028', product_code: 'EPAYTEST' };
    const reference = signEsewaRequest(base, UAT_SECRET);

    expect(signEsewaRequest({ ...base, total_amount: '110.0' }, UAT_SECRET)).not.toBe(reference);
    expect(signEsewaRequest({ ...base, transaction_uuid: '241029' }, UAT_SECRET)).not.toBe(
      reference,
    );
    expect(signEsewaRequest(base, 'another-secret')).not.toBe(reference);
  });
});

describe('eSewa callback verification', () => {
  it('verifies eSewa’s published callback vector', () => {
    const fields = decodeEsewaCallback(toBase64(DOCUMENTED_CALLBACK_JSON));

    expect(verifyEsewaCallbackSignature(fields, UAT_SECRET)).toBe(true);
  });

  it('keeps numbers as their source text ("1000.0", which the signature covers)', () => {
    const fields = decodeEsewaCallback(toBase64(DOCUMENTED_CALLBACK_JSON));

    expect(fields.total_amount).toBe('1000.0');
    expect(fields.status).toBe('COMPLETE');
  });

  it('rejects a tampered amount, status or signature', () => {
    for (const tampered of [
      DOCUMENTED_CALLBACK_JSON.replace('1000.0', '10.0'),
      DOCUMENTED_CALLBACK_JSON.replace('"COMPLETE"', '"PENDING"'),
      DOCUMENTED_CALLBACK_JSON.replace('62GcfZ', '62GcfA'),
    ]) {
      expect(
        verifyEsewaCallbackSignature(decodeEsewaCallback(toBase64(tampered)), UAT_SECRET),
      ).toBe(false);
    }
  });

  it('rejects a callback signed with a different secret', () => {
    const fields = decodeEsewaCallback(toBase64(DOCUMENTED_CALLBACK_JSON));

    expect(verifyEsewaCallbackSignature(fields, 'not-the-merchant-secret')).toBe(false);
  });

  it('rejects callbacks that leave amount or status out of the signed set', () => {
    const fields = {
      status: 'COMPLETE',
      total_amount: '1000.0',
      transaction_uuid: 'x',
      product_code: 'EPAYTEST',
      signed_field_names: 'transaction_uuid,product_code,signed_field_names',
    };
    const signature = esewaHmacBase64(
      esewaSignatureMessage(fields, ['transaction_uuid', 'product_code', 'signed_field_names']),
      UAT_SECRET,
    );

    expect(verifyEsewaCallbackSignature({ ...fields, signature }, UAT_SECRET)).toBe(false);
  });

  it('rejects malformed payloads', () => {
    expect(() => decodeEsewaCallback(toBase64('[1,2]'))).toThrow('not a JSON object');
    expect(verifyEsewaCallbackSignature({ status: 'COMPLETE' }, UAT_SECRET)).toBe(false);
  });
});

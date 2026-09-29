import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * eSewa ePay v2 signatures (SPEC: Nepal localizations §1).
 *
 *   signed_field_names = "total_amount,transaction_uuid,product_code"
 *   message            = "total_amount=<v>,transaction_uuid=<v>,product_code=<v>"
 *   signature          = Base64( HMAC-SHA256(message, secret_key) )
 *
 * SPEC writes the message as "total_amount,transaction_uuid,product_code", which is the
 * signed_field_names list. eSewa signs `name=value` pairs in exactly that order. This is
 * proven by eSewa's published vectors, which the unit tests pin.
 * The callback is signed the same way over its own signed_field_names, using the values
 * exactly as eSewa serialised them (e.g. "1000.0", not 1000).
 */

export const ESEWA_REQUEST_SIGNED_FIELDS = [
  'total_amount',
  'transaction_uuid',
  'product_code',
] as const;

/** Builds the HMAC message from `name=value` pairs in the given field order. */
export function esewaSignatureMessage(
  fields: Readonly<Record<string, string>>,
  signedFieldNames: readonly string[],
): string {
  return signedFieldNames
    .map((name) => {
      const value = fields[name];
      if (value === undefined) {
        throw new Error(`Signed field "${name}" is missing`);
      }
      return `${name}=${value}`;
    })
    .join(',');
}

/** HMAC-SHA256 over the message, encoded strictly as standard Base64 (not hex, not base64url). */
export function esewaHmacBase64(message: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(message, 'utf8').digest('base64');
}

export interface EsewaRequestSignatureInput {
  readonly total_amount: string;
  readonly transaction_uuid: string;
  readonly product_code: string;
}

/** Signature for the payment form posted to eSewa. */
export function signEsewaRequest(input: EsewaRequestSignatureInput, secretKey: string): string {
  return esewaHmacBase64(
    esewaSignatureMessage({ ...input }, ESEWA_REQUEST_SIGNED_FIELDS),
    secretKey,
  );
}

export type EsewaCallbackFields = Readonly<Record<string, string>>;

/**
 * Decodes the base64 `data` eSewa appends to the success redirect. Numbers keep their source
 * text: JSON.parse would turn `1000.0` into `1000`, and the signature is over "1000.0".
 */
export function decodeEsewaCallback(data: string): EsewaCallbackFields {
  const json = Buffer.from(data, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(json, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? (context?.source ?? String(value)) : value,
  );
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('eSewa callback data is not a JSON object');
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') fields[key] = value;
  }
  return fields;
}

/**
 * Verifies a decoded callback's signature over its own signed_field_names. The callback must sign
 * at least the fields we act on, so an attacker cannot drop them from the signed set.
 */
export function verifyEsewaCallbackSignature(
  fields: EsewaCallbackFields,
  secretKey: string,
): boolean {
  const signature = fields.signature;
  const signedFieldNames = fields.signed_field_names?.split(',').map((f) => f.trim());
  if (signature === undefined || signedFieldNames === undefined) {
    return false;
  }
  const required = [
    'status',
    'total_amount',
    'transaction_uuid',
    'product_code',
    'signed_field_names',
  ];
  if (!required.every((field) => signedFieldNames.includes(field))) {
    return false;
  }

  let expected: string;
  try {
    expected = esewaHmacBase64(esewaSignatureMessage(fields, signedFieldNames), secretKey);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

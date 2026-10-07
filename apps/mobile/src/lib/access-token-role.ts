import { userRoleSchema, type UserRole } from '@hamro-pasal/shared-types';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Decodes unpadded base64url to a UTF-8 string, or null if it is not base64url. */
function decodeBase64Url(input: string): string | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of input.replace(/=+$/, '')) {
    const value = BASE64URL.indexOf(char);
    if (value === -1) return null;
    buffer = ((buffer << 6) | value) & 0xffff; // at most 14 pending bits matter
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(
      bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    return null;
  }
}

/**
 * The `role` claim of an access token (HS256 JWT `{ sub, role }`), or null if the token cannot be
 * read. The signature is NOT verified: the app only uses the role to pick which screens to show
 * (the customer tabs or the vendor dashboard). The server checks the role on every request.
 */
export function accessTokenRole(token: string): UserRole | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  const json = decodeBase64Url(payload);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== 'object' || claims === null) return null;
    const role = userRoleSchema.safeParse(Reflect.get(claims, 'role'));
    return role.success ? role.data : null;
  } catch {
    return null;
  }
}

/**
 * The `sub` claim (the account's id) of an access or refresh token, or null if it cannot be read.
 * Not verified either: the app uses it only to tell which account local profile details belong to.
 */
export function tokenSubject(token: string): string | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  const json = decodeBase64Url(payload);
  if (json === null) return null;
  try {
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== 'object' || claims === null) return null;
    const subject: unknown = Reflect.get(claims, 'sub');
    return typeof subject === 'string' && subject !== '' ? subject : null;
  } catch {
    return null;
  }
}

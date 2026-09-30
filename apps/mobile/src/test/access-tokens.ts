import type { UserRole } from '@hamro-pasal/shared-types';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Url(text: string): string {
  // Claims here are ASCII (uuids, role names, numbers), so one char is one byte.
  const bytes = Array.from(text, (char) => char.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(i, i + 3);
    const chunk = (a << 16) | (b << 8) | c;
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j += 1) out += BASE64URL.charAt((chunk >> (18 - 6 * j)) & 63);
  }
  return out;
}

/**
 * A JWT-shaped access token carrying `role`, as the API issues them (HS256 `{ sub, role }`). The
 * signature is fake: the app never verifies tokens, it only reads the role claim.
 */
export function accessTokenFor(
  role: UserRole,
  sub = '9f1c2a10-0000-4000-8000-000000000001',
): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({ sub, role, iss: 'hamro-pasal-api', aud: 'hamro-pasal-app', exp: 4102444800 }),
  );
  return `${header}.${payload}.fake-signature`;
}

import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { signAccessToken, verifyAccessToken } from './access-token';
import { REFRESH_TOKEN, signRefreshToken, verifyRefreshToken } from './refresh-token';

const ACCESS_SECRET = 'a'.repeat(48);
const REFRESH_SECRET = 'r'.repeat(48);

describe('refresh tokens', () => {
  it('round-trips the user id with a 7-day expiry and a unique token id', () => {
    const userId = randomUUID();
    const first = signRefreshToken(userId, REFRESH_SECRET);
    const second = signRefreshToken(userId, REFRESH_SECRET);

    const claims = verifyRefreshToken(first, REFRESH_SECRET);
    expect(claims.userId).toBe(userId);
    expect(claims.tokenId).not.toBe(verifyRefreshToken(second, REFRESH_SECRET).tokenId);
    const decoded = jwt.decode(first) as { exp: number; iat: number; aud: string; typ: string };
    expect(decoded.exp - decoded.iat).toBe(7 * 24 * 60 * 60);
    expect(REFRESH_TOKEN.ttlSeconds).toBe(604_800);
    expect(decoded).toMatchObject({ aud: 'hamro-pasal-refresh', typ: 'refresh' });
  });

  it('rejects a refresh token signed with the access secret', () => {
    const forged = signRefreshToken(randomUUID(), ACCESS_SECRET);

    expect(() => verifyRefreshToken(forged, REFRESH_SECRET)).toThrow('invalid signature');
  });

  it('can never be used as an access token, nor an access token as a refresh token', () => {
    const userId = randomUUID();
    const refresh = signRefreshToken(userId, REFRESH_SECRET);
    const access = signAccessToken({ userId, role: 'CUSTOMER' }, ACCESS_SECRET);

    expect(() => verifyAccessToken(refresh, ACCESS_SECRET)).toThrow('Invalid access token');
    expect(() => verifyAccessToken(refresh, REFRESH_SECRET)).toThrow('Invalid access token');
    expect(() => verifyRefreshToken(access, REFRESH_SECRET)).toThrow('Invalid refresh token');
    expect(() => verifyRefreshToken(access, ACCESS_SECRET)).toThrow('Invalid refresh token');
  });

  it('rejects expired tokens and tokens without the refresh type', () => {
    const expired = jwt.sign({ typ: 'refresh' }, REFRESH_SECRET, {
      subject: randomUUID(),
      jwtid: randomUUID(),
      issuer: REFRESH_TOKEN.issuer,
      audience: REFRESH_TOKEN.audience,
      expiresIn: -1,
    });
    const untyped = jwt.sign({}, REFRESH_SECRET, {
      subject: randomUUID(),
      jwtid: randomUUID(),
      issuer: REFRESH_TOKEN.issuer,
      audience: REFRESH_TOKEN.audience,
      expiresIn: 60,
    });

    expect(() => verifyRefreshToken(expired, REFRESH_SECRET)).toThrow('jwt expired');
    expect(() => verifyRefreshToken(untyped, REFRESH_SECRET)).toThrow('unexpected claims');
  });
});

import { randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { ACCESS_TOKEN, signAccessToken, verifyAccessToken } from './access-token';

const SECRET = 'a'.repeat(48);

describe('access tokens', () => {
  it('round-trips user id and role with a 15-minute expiry', () => {
    const userId = randomUUID();
    const token = signAccessToken({ userId, role: 'CUSTOMER' }, SECRET);

    expect(verifyAccessToken(token, SECRET)).toEqual({ userId, role: 'CUSTOMER' });
    const decoded = jwt.decode(token) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(ACCESS_TOKEN.ttlSeconds);
    expect(ACCESS_TOKEN.ttlSeconds).toBe(900);
  });

  it('rejects a token signed with another secret', () => {
    const token = signAccessToken({ userId: randomUUID(), role: 'CUSTOMER' }, 'b'.repeat(48));

    expect(() => verifyAccessToken(token, SECRET)).toThrow('invalid signature');
  });

  it('rejects unsigned (alg: none) tokens', () => {
    const unsigned = jwt.sign({ role: 'CUSTOMER' }, '', {
      algorithm: 'none',
      subject: randomUUID(),
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience,
    });

    expect(() => verifyAccessToken(unsigned, SECRET)).toThrow('Invalid access token');
  });

  it('rejects expired tokens and the wrong audience', () => {
    const expired = jwt.sign({ role: 'CUSTOMER' }, SECRET, {
      subject: randomUUID(),
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience,
      expiresIn: -10,
    });
    const otherAudience = jwt.sign({ role: 'CUSTOMER' }, SECRET, {
      subject: randomUUID(),
      issuer: ACCESS_TOKEN.issuer,
      audience: 'someone-else',
      expiresIn: 60,
    });

    expect(() => verifyAccessToken(expired, SECRET)).toThrow('jwt expired');
    expect(() => verifyAccessToken(otherAudience, SECRET)).toThrow('audience invalid');
  });

  it('rejects tokens with a malformed subject or unknown role', () => {
    const badSubject = jwt.sign({ role: 'CUSTOMER' }, SECRET, {
      subject: 'not-a-uuid',
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience,
      expiresIn: 60,
    });
    const badRole = jwt.sign({ role: 'ROOT' }, SECRET, {
      subject: randomUUID(),
      issuer: ACCESS_TOKEN.issuer,
      audience: ACCESS_TOKEN.audience,
      expiresIn: 60,
    });

    expect(() => verifyAccessToken(badSubject, SECRET)).toThrow('unexpected claims');
    expect(() => verifyAccessToken(badRole, SECRET)).toThrow('unexpected claims');
  });
});

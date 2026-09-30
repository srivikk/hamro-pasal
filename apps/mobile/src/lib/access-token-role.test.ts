import { accessTokenFor } from '../test/access-tokens';
import { accessTokenRole } from './access-token-role';

describe('accessTokenRole', () => {
  it.each(['CUSTOMER', 'VENDOR', 'DRIVER', 'SUPER_ADMIN'] as const)(
    'reads the %s role claim of an access token',
    (role) => {
      expect(accessTokenRole(accessTokenFor(role))).toBe(role);
    },
  );

  it('reads a real token minted by the API (signAccessToken, test secret)', () => {
    const token =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiVkVORE9SIiwiaWF0IjoxNzkwNzYyNjAxLCJleHAiOjE3OTA3NjM1MDEsImF1ZCI6ImhhbXJvLXBhc2FsLWFwcCIsImlzcyI6ImhhbXJvLXBhc2FsLWFwaSIsInN1YiI6IjZmMWMyYTEwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAxMSJ9.XkDOJLaAxLBaxLQGDga41TWRUOYs3C6spSyLuTTiuRU';

    expect(accessTokenRole(token)).toBe('VENDOR');
  });

  it('returns null for anything that is not a readable token with a known role', () => {
    expect(accessTokenRole('')).toBeNull();
    expect(accessTokenRole('not-a-jwt')).toBeNull();
    expect(accessTokenRole('a.!!!.c')).toBeNull();
    expect(accessTokenRole('eyJhbGciOiJIUzI1NiJ9.test-access-token.signature')).toBeNull();
    expect(accessTokenRole('h.eyJyb2xlIjoiT1dORVIifQ.s')).toBeNull(); // {"role":"OWNER"}
  });
});

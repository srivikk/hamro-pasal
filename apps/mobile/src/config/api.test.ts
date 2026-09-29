import { ApiConfigError, parseApiUrl } from './parse-api-url';
import type * as ApiModule from './api';

describe('parseApiUrl', () => {
  it.each([
    ['http://192.168.1.20:4000', 'http://192.168.1.20:4000'],
    ['http://192.168.1.20:4000/', 'http://192.168.1.20:4000'],
    ['  https://api.hamropasal.com.np  ', 'https://api.hamropasal.com.np'],
    ['https://api.hamropasal.com.np/v1//', 'https://api.hamropasal.com.np/v1'],
    ['http://10.0.2.2:4000', 'http://10.0.2.2:4000'],
  ])('accepts %p as %p', (raw, expected) => {
    expect(parseApiUrl(raw)).toBe(expected);
  });

  it.each([undefined, '', '   '])('fails loudly when the variable is missing (%p)', (raw) => {
    expect(() => parseApiUrl(raw)).toThrow(ApiConfigError);
    expect(() => parseApiUrl(raw)).toThrow(/EXPO_PUBLIC_API_URL is not set/);
    expect(() => parseApiUrl(raw)).toThrow(/apps\/mobile\/\.env/);
  });

  it.each([
    '192.168.1.20:4000',
    'localhost:4000',
    'ftp://192.168.1.20',
    'http://',
    'http://host:4000?debug=1',
    'http://host:4000#x',
    'http://my host:4000',
    'http://host:port',
  ])('rejects the malformed URL %p', (raw) => {
    expect(() => parseApiUrl(raw)).toThrow(ApiConfigError);
    expect(() => parseApiUrl(raw)).toThrow(`Received: "${raw}"`);
  });
});

describe('API_URL module export', () => {
  const original = process.env.EXPO_PUBLIC_API_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = original;
  });

  function loadApiUrl(): string {
    let apiUrl = '';
    jest.isolateModules(() => {
      apiUrl = jest.requireActual<typeof ApiModule>('./api').API_URL;
    });
    return apiUrl;
  }

  it('exports the parsed URL at startup', () => {
    process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.20:4000/';

    expect(loadApiUrl()).toBe('http://192.168.1.20:4000');
  });

  it('throws while the module loads when the variable is undefined', () => {
    delete process.env.EXPO_PUBLIC_API_URL;

    expect(loadApiUrl).toThrow(/EXPO_PUBLIC_API_URL is not set/);
  });
});

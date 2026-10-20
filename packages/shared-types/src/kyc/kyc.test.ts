import { parseServerEnv } from '../env/server-env';
import {
  bestBusinessNameMatch,
  businessNameSimilarity,
  graphemes,
  IRD_NAME_MATCH_THRESHOLD,
  levenshtein,
  normaliseBusinessName,
} from './name-match';
import { isPanChecksumValid, mod11_2CheckCharacter, mod11_2CheckValue } from './pan-checksum';

describe('ISO/IEC 7064 MOD 11-2', () => {
  it("matches the standard's published vectors", () => {
    // ISO/IEC 7064 annex example: 079 -> X.
    expect(mod11_2CheckCharacter('079')).toBe('X');
    // ISNI 0000 0002 1825 0097 (the ISNI check character is MOD 11-2).
    expect(mod11_2CheckCharacter('000000021825009')).toBe('7');
    // ORCID iD 0000-0002-1694-233X (also MOD 11-2).
    expect(mod11_2CheckCharacter('000000021694233')).toBe('X');
  });

  it('refuses anything but ASCII digits as a payload', () => {
    expect(() => mod11_2CheckValue('12a4')).toThrow();
    expect(() => mod11_2CheckValue('१२३')).toThrow();
  });

  it('accepts a PAN whose ninth digit is the check digit of the first eight, and no other', () => {
    const payload = '30211884';
    const check = mod11_2CheckCharacter(payload);
    expect(check).toMatch(/^[0-9]$/);
    expect(isPanChecksumValid(`${payload}${check}`)).toBe(true);
    for (let digit = 0; digit <= 9; digit += 1) {
      if (String(digit) === check) continue;
      expect(isPanChecksumValid(`${payload}${String(digit)}`)).toBe(false);
    }
  });

  it('never accepts a PAN whose check value is X, nor a malformed one', () => {
    let xPayload = '';
    for (let n = 10_000_000; xPayload === ''; n += 1) {
      if (mod11_2CheckValue(String(n)) === 10) xPayload = String(n);
    }
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(isPanChecksumValid(`${xPayload}${String(digit)}`)).toBe(false);
    }
    expect(isPanChecksumValid('12345678')).toBe(false);
    expect(isPanChecksumValid('1234567890')).toBe(false);
    expect(isPanChecksumValid('12345678X')).toBe(false);
  });
});

describe('business name matching', () => {
  it('normalises case, punctuation, "&" and the legal-form words', () => {
    expect(normaliseBusinessName('Thamel Kirana Pasal Pvt. Ltd.')).toEqual([
      'thamel',
      'kirana',
      'pasal',
    ]);
    expect(normaliseBusinessName('Ram & Sita Traders (P.) Limited')).toEqual([
      'ram',
      'and',
      'sita',
      'traders',
    ]);
    expect(normaliseBusinessName('हाम्रो पसल प्रा.लि.')).toEqual(['हाम्रो', 'पसल', 'प्रा', 'लि']);
  });

  it('computes the Levenshtein distance by code point', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('पसल', 'पसल')).toBe(0);
    // A consonant with its vowel sign is one character: का and कि differ by one, not two.
    expect(graphemes('का')).toEqual(['का']);
    expect(levenshtein('काम', 'किम')).toBe(1);
  });

  it.each([
    ['THAMEL KIRANA PASAL PVT. LTD.', 'Thamel Kirana Pasal'],
    ['Thamel Kirana Pasal', 'Kirana Pasal, Thamel'],
    ['Patan Organic Store', 'Patan Organic Stores'],
    ['New Road Electronics', 'Newroad Electronics'],
  ])('matches "%s" with "%s"', (ird, vendor) => {
    expect(businessNameSimilarity(ird, vendor)).toBeGreaterThanOrEqual(IRD_NAME_MATCH_THRESHOLD);
  });

  it.each([
    ['Thamel Kirana Pasal', 'Boudha Fresh Mart'],
    ['Asan Masala Pasal', 'Bhaktapur Sweets Pasal'],
    ['Thamel Kirana Pasal', 'Thamel Kirana Pasal and Hardware Suppliers'],
    ['Kirana', ''],
  ])('does not match "%s" with "%s"', (ird, vendor) => {
    expect(businessNameSimilarity(ird, vendor)).toBeLessThan(IRD_NAME_MATCH_THRESHOLD);
  });

  it('takes the best of the legal and the business name, ignoring empty ones', () => {
    expect(
      bestBusinessNameMatch('Shrestha Traders Pvt Ltd', ['Shrestha Traders', 'Thamel Mart']),
    ).toBe(1);
    expect(bestBusinessNameMatch('Shrestha Traders', [null, '  '])).toBe(0);
  });
});

describe('IRD verification settings', () => {
  const base: Record<string, string> = {
    COUNTRY_CODE: 'NP',
    DATABASE_URL: 'postgresql://hamro:hamro@localhost:5432/hamro_pasal',
    REDIS_URL: 'redis://localhost:6379',
    KAFKA_BROKERS: 'localhost:9092',
    KAFKA_CLIENT_ID: 'hamro-pasal',
    KAFKA_CONSUMER_GROUP_ID: 'hamro-pasal-worker',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    ESEWA_PRODUCT_CODE: 'EPAYTEST',
    ESEWA_SECRET_KEY: 'esewa-secret',
    ESEWA_PAYMENT_URL: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
    ESEWA_STATUS_CHECK_URL: 'https://rc.esewa.com.np/api/epay/transaction/status/',
    ESEWA_SUCCESS_URL: 'http://localhost:4000/payments/esewa/success',
    ESEWA_FAILURE_URL: 'http://localhost:4000/payments/esewa/failure',
    KHALTI_SECRET_KEY: 'khalti-secret',
    KHALTI_BASE_URL: 'https://a.khalti.com/api/v2',
    KHALTI_RETURN_URL: 'http://localhost:4000/payments/khalti/return',
    KHALTI_WEBSITE_URL: 'http://localhost:4000',
    SMS_PROVIDER: 'MOCK',
  };

  it('is off by default, with the checksum not enforced and no proxy', () => {
    const env = parseServerEnv(base);
    expect(env.IRD_VERIFICATION_PROVIDER).toBe('DISABLED');
    expect(env.PAN_CHECKSUM_ENFORCED).toBe(false);
    expect(env.IRD_PROXY_URLS).toEqual([]);
    expect(env.IRD_PAN_SEARCH_URL).toBe('https://ird.gov.np/pan-search/');
  });

  it('needs a 2Captcha key for the browser provider, and reads the proxy list', () => {
    expect(() => parseServerEnv({ ...base, IRD_VERIFICATION_PROVIDER: 'PLAYWRIGHT' })).toThrow(
      /TWOCAPTCHA_API_KEY/,
    );
    const env = parseServerEnv({
      ...base,
      IRD_VERIFICATION_PROVIDER: 'PLAYWRIGHT',
      TWOCAPTCHA_API_KEY: 'key',
      IRD_PROXY_URLS: 'http://u:p@proxy-a:8080, socks5://proxy-b:1080',
    });
    expect(env.IRD_PROXY_URLS).toEqual(['http://u:p@proxy-a:8080', 'socks5://proxy-b:1080']);
    expect(() => parseServerEnv({ ...base, IRD_PROXY_URLS: 'not a url' })).toThrow();
  });

  it('refuses the mock in production, and MOCK_SERVICES turns it on locally', () => {
    expect(() =>
      parseServerEnv({ ...base, NODE_ENV: 'production', IRD_VERIFICATION_PROVIDER: 'MOCK' }),
    ).toThrow(/IRD_VERIFICATION_PROVIDER/);
    expect(parseServerEnv({ ...base, MOCK_SERVICES: 'true' }).IRD_VERIFICATION_PROVIDER).toBe(
      'MOCK',
    );
  });
});

import { InvalidEnvError, mockServicesEnabled, parseServerEnv } from './server-env';

const validEnv: Record<string, string> = {
  COUNTRY_CODE: 'NP',
  DATABASE_URL: 'postgresql://hamro:hamro@localhost:5432/hamro_pasal',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:9092, localhost:9093',
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
  SMS_PROVIDER: 'SPARROW',
  SPARROW_SMS_TOKEN: 'sparrow-token',
  SPARROW_SMS_FROM: 'HamroPasal',
  SPARROW_SMS_API_URL: 'https://api.sparrowsms.com/v2/sms/',
};

const expectInvalid = (env: Record<string, string>, fragment: string): void => {
  expect(() => parseServerEnv(env)).toThrow(InvalidEnvError);
  expect(() => parseServerEnv(env)).toThrow(fragment);
};

describe('parseServerEnv', () => {
  it('parses a complete environment and applies defaults', () => {
    const env = parseServerEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.API_PORT).toBe(4000);
    expect(env.POSTGIS_SRID).toBe(4326);
    expect(env.KAFKA_SSL).toBe(false);
    expect(env.KAFKA_BROKERS).toEqual(['localhost:9092', 'localhost:9093']);
  });

  it('coerces numeric and boolean strings', () => {
    const env = parseServerEnv({ ...validEnv, API_PORT: '8080', KAFKA_SSL: 'true' });

    expect(env.API_PORT).toBe(8080);
    expect(env.KAFKA_SSL).toBe(true);
  });

  it('allows no cross-origin caller by default and parses an exact allowlist', () => {
    expect(parseServerEnv(validEnv).CORS_ALLOWED_ORIGINS).toEqual([]);
    expect(parseServerEnv({ ...validEnv, CORS_ALLOWED_ORIGINS: '' }).CORS_ALLOWED_ORIGINS).toEqual(
      [],
    );
    expect(
      parseServerEnv({
        ...validEnv,
        CORS_ALLOWED_ORIGINS: ' https://admin.hamropasal.np , http://localhost:5173,',
      }).CORS_ALLOWED_ORIGINS,
    ).toEqual(['https://admin.hamropasal.np', 'http://localhost:5173']);
  });

  it('rejects a wildcard, a path and a non-http origin in the CORS allowlist', () => {
    for (const origin of [
      '*',
      'https://*.hamropasal.np',
      'https://admin.hamropasal.np/',
      'admin.hamropasal.np',
      'ftp://admin.hamropasal.np',
      'null',
    ]) {
      expectInvalid({ ...validEnv, CORS_ALLOWED_ORIGINS: origin }, 'CORS_ALLOWED_ORIGINS');
    }
  });

  it('allows only https origins in production', () => {
    // Production keeps its files in a bucket (Phase 34): the local disk is refused there.
    const production = {
      ...validEnv,
      NODE_ENV: 'production',
      STORAGE_DRIVER: 'S3',
      S3_PUBLIC_BUCKET: 'hp-public',
      S3_PRIVATE_BUCKET: 'hp-private',
      S3_PUBLIC_BASE_URL: 'https://cdn.hamropasal.np',
    };
    expect(
      parseServerEnv({ ...production, CORS_ALLOWED_ORIGINS: 'https://admin.hamropasal.np' })
        .CORS_ALLOWED_ORIGINS,
    ).toEqual(['https://admin.hamropasal.np']);
    expectInvalid(
      { ...production, CORS_ALLOWED_ORIGINS: 'http://localhost:5173' },
      'Only https origins may call the API in production',
    );
  });

  it('treats empty strings as unset', () => {
    expectInvalid({ ...validEnv, ESEWA_SECRET_KEY: '' }, 'ESEWA_SECRET_KEY');
  });

  it('rejects any country code other than NP', () => {
    expectInvalid({ ...validEnv, COUNTRY_CODE: 'IN' }, 'COUNTRY_CODE');
  });

  it('rejects non-postgres database URLs', () => {
    expectInvalid({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' }, 'DATABASE_URL');
  });

  it('rejects non-redis cache URLs', () => {
    expectInvalid({ ...validEnv, REDIS_URL: 'http://localhost:6379' }, 'REDIS_URL');
  });

  it('rejects an empty Kafka broker list', () => {
    expectInvalid({ ...validEnv, KAFKA_BROKERS: ' , ' }, 'KAFKA_BROKERS');
  });

  it('rejects JWT secrets shorter than 32 characters', () => {
    expectInvalid({ ...validEnv, JWT_ACCESS_SECRET: 'short' }, 'JWT_ACCESS_SECRET');
  });

  it('rejects identical access and refresh secrets', () => {
    expectInvalid(
      { ...validEnv, JWT_REFRESH_SECRET: validEnv.JWT_ACCESS_SECRET ?? '' },
      'Must differ from JWT_ACCESS_SECRET',
    );
  });

  it('rejects a JWT secret that is also a payment gateway key', () => {
    const shared = 'g'.repeat(32);
    expectInvalid(
      { ...validEnv, JWT_ACCESS_SECRET: shared, ESEWA_SECRET_KEY: shared },
      'Must differ from ESEWA_SECRET_KEY',
    );
    expectInvalid(
      { ...validEnv, JWT_REFRESH_SECRET: shared, KHALTI_SECRET_KEY: shared },
      'Must differ from KHALTI_SECRET_KEY',
    );
  });

  it('requires SASL credentials when a SASL mechanism is set', () => {
    expectInvalid({ ...validEnv, KAFKA_SASL_MECHANISM: 'plain' }, 'KAFKA_SASL_USERNAME');
  });

  it('requires credentials for the selected SMS provider only', () => {
    expectInvalid({ ...validEnv, SMS_PROVIDER: 'AAKASH' }, 'AAKASH_SMS_AUTH_TOKEN');

    const env = parseServerEnv({
      ...validEnv,
      SMS_PROVIDER: 'FIREBASE',
      FIREBASE_PROJECT_ID: 'hamro-pasal',
      FIREBASE_CLIENT_EMAIL: 'sa@hamro-pasal.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'key',
    });
    expect(env.SMS_PROVIDER).toBe('FIREBASE');
  });

  it('allows the MOCK SMS provider outside production only', () => {
    expect(parseServerEnv({ ...validEnv, SMS_PROVIDER: 'MOCK' }).SMS_PROVIDER).toBe('MOCK');
    expectInvalid(
      { ...validEnv, SMS_PROVIDER: 'MOCK', NODE_ENV: 'production' },
      'not allowed in production',
    );
  });

  it('disables wallet top-ups by default and allows the MOCK top-up outside production only', () => {
    expect(parseServerEnv(validEnv).WALLET_TOP_UP_MODE).toBe('DISABLED');
    expect(parseServerEnv({ ...validEnv, WALLET_TOP_UP_MODE: 'MOCK' }).WALLET_TOP_UP_MODE).toBe(
      'MOCK',
    );
    expectInvalid(
      { ...validEnv, WALLET_TOP_UP_MODE: 'MOCK', NODE_ENV: 'production' },
      'WALLET_TOP_UP_MODE',
    );
    expectInvalid({ ...validEnv, WALLET_TOP_UP_MODE: 'FREE' }, 'WALLET_TOP_UP_MODE');
  });

  it('disables IVR calls by default and allows the MOCK IVR outside production only', () => {
    expect(parseServerEnv(validEnv).IVR_PROVIDER).toBe('DISABLED');
    expect(parseServerEnv({ ...validEnv, IVR_PROVIDER: 'MOCK' }).IVR_PROVIDER).toBe('MOCK');
    expectInvalid({ ...validEnv, IVR_PROVIDER: 'MOCK', NODE_ENV: 'production' }, 'IVR_PROVIDER');
    expectInvalid({ ...validEnv, IVR_PROVIDER: 'TWILIO' }, 'IVR_PROVIDER');
  });

  it('keeps MOCK_SERVICES off by default and refuses it in production', () => {
    const off = parseServerEnv(validEnv);
    expect(off.MOCK_SERVICES).toBe(false);
    expect(mockServicesEnabled(off)).toBe(false);

    const on = parseServerEnv({ ...validEnv, MOCK_SERVICES: 'true' });
    expect(on.MOCK_SERVICES).toBe(true);
    expect(mockServicesEnabled(on)).toBe(true);

    expectInvalid({ ...validEnv, MOCK_SERVICES: 'true', NODE_ENV: 'production' }, 'MOCK_SERVICES');
    expect(mockServicesEnabled({ MOCK_SERVICES: true, NODE_ENV: 'production' })).toBe(false);
  });

  it('answers SMS and IVR as MOCK while MOCK_SERVICES is on, and leaves them alone otherwise', () => {
    const on = parseServerEnv({ ...validEnv, MOCK_SERVICES: 'true' });
    expect(on.SMS_PROVIDER).toBe('MOCK');
    expect(on.IVR_PROVIDER).toBe('MOCK');

    const off = parseServerEnv({ ...validEnv, MOCK_SERVICES: 'false' });
    expect(off.SMS_PROVIDER).toBe(validEnv.SMS_PROVIDER);
    expect(off.IVR_PROVIDER).toBe('DISABLED');
  });
});

describe('mail settings (step 7.1)', () => {
  const ses = {
    MAIL_PROVIDER: 'SES_SMTP',
    SES_SMTP_HOST: 'email-smtp.ap-south-1.amazonaws.com',
    SES_SMTP_USER: 'AKIAEXAMPLE',
    SES_SMTP_PASSWORD: 'smtp-password',
    MAIL_FROM: 'exports@hamropasal.np',
  };

  it('is DISABLED by default, with SES on port 587', () => {
    const env = parseServerEnv(validEnv);
    expect(env.MAIL_PROVIDER).toBe('DISABLED');
    expect(parseServerEnv({ ...validEnv, ...ses }).SES_SMTP_PORT).toBe(587);
  });

  it('needs every SES key for SES_SMTP', () => {
    for (const key of Object.keys(ses).filter((k) => k !== 'MAIL_PROVIDER')) {
      expect(() => parseServerEnv({ ...validEnv, ...ses, [key]: '' })).toThrow(key);
    }
  });

  it('refuses MOCK in production, and MOCK_SERVICES answers it as MOCK', () => {
    expect(() =>
      parseServerEnv({ ...validEnv, NODE_ENV: 'production', MAIL_PROVIDER: 'MOCK' }),
    ).toThrow('MAIL_PROVIDER');
    expect(parseServerEnv({ ...validEnv, ...ses, MOCK_SERVICES: 'true' }).MAIL_PROVIDER).toBe(
      'MOCK',
    );
  });
});

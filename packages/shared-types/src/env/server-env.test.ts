import { InvalidEnvError, parseServerEnv } from './server-env';

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
});

import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const optionalNonEmpty = nonEmpty.optional();

/**
 * SPARROW / AAKASH send the API's own OTP. FIREBASE is declared for completeness but cannot deliver
 * a server-generated code (Firebase Auth sends its own). MOCK prints the SMS to the API log and is
 * refused in production; it exists so local end-to-end runs need no paid SMS account.
 */
export const smsProviders = ['SPARROW', 'AAKASH', 'FIREBASE', 'MOCK'] as const;
export type SmsProvider = (typeof smsProviders)[number];

/**
 * Vendor wallet top-ups (SPEC §5: debts are cleared by an upfront eSewa payment). No gateway flow
 * exists for top-ups yet: MOCK credits the wallet without taking a payment and is refused in
 * production; DISABLED (the default) answers 503 TOP_UP_UNAVAILABLE.
 */
export const walletTopUpModes = ['MOCK', 'DISABLED'] as const;
export type WalletTopUpMode = (typeof walletTopUpModes)[number];

/**
 * IVR voice calls for the 90 s vendor escalation (infrastructure §6: Twilio Voice or a Nepal SIP
 * trunk). No real provider is wired yet: MOCK logs each call instead of placing it and is refused
 * in production; DISABLED (the default) places no call, so the escalation is SMS only.
 */
export const ivrProviders = ['MOCK', 'DISABLED'] as const;
export type IvrProvider = (typeof ivrProviders)[number];

export const kafkaSaslMechanisms = ['plain', 'scram-sha-256', 'scram-sha-512'] as const;
export type KafkaSaslMechanism = (typeof kafkaSaslMechanisms)[number];

/** Kafka connection variables, also usable on their own (e.g. by broker integration tests). */
const kafkaEnvShape = {
  KAFKA_BROKERS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
    )
    .pipe(z.array(z.string()).min(1)),
  KAFKA_CLIENT_ID: nonEmpty,
  KAFKA_CONSUMER_GROUP_ID: nonEmpty,
  KAFKA_SSL: z.stringbool().default(false),
  KAFKA_SASL_MECHANISM: z.enum(kafkaSaslMechanisms).optional(),
  KAFKA_SASL_USERNAME: optionalNonEmpty,
  KAFKA_SASL_PASSWORD: optionalNonEmpty,
};

export const kafkaEnvSchema = z.object(kafkaEnvShape);
export type KafkaEnvVars = z.infer<typeof kafkaEnvSchema>;

/** Validates only the Kafka variables (empty strings treated as unset). */
export function parseKafkaEnv(source: Readonly<Record<string, string | undefined>>): KafkaEnvVars {
  const result = kafkaEnvSchema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new InvalidEnvError(z.prettifyError(result.error));
  }
  return result.data;
}

/**
 * Runtime configuration shared by `apps/api` and `apps/worker`.
 * Every variable here is declared in the root `.env.example`.
 */
export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    COUNTRY_CODE: z.literal('NP'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    // PostgreSQL + PostGIS
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    POSTGIS_SRID: z.coerce.number().int().positive().default(4326),

    // Redis (inventory locks, rate limiting, BullMQ)
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    // Kafka
    ...kafkaEnvShape,

    // JWT
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),

    // eSewa ePay v2
    ESEWA_PRODUCT_CODE: nonEmpty,
    ESEWA_SECRET_KEY: nonEmpty,
    ESEWA_PAYMENT_URL: z.url(),
    ESEWA_STATUS_CHECK_URL: z.url(),
    ESEWA_SUCCESS_URL: z.url(),
    ESEWA_FAILURE_URL: z.url(),

    // Khalti ePay v2
    KHALTI_SECRET_KEY: nonEmpty,
    KHALTI_BASE_URL: z.url(),
    KHALTI_RETURN_URL: z.url(),
    KHALTI_WEBSITE_URL: z.url(),

    // SMS / OTP
    SMS_PROVIDER: z.enum(smsProviders),
    SPARROW_SMS_TOKEN: optionalNonEmpty,
    SPARROW_SMS_FROM: optionalNonEmpty,
    SPARROW_SMS_API_URL: z.url().optional(),
    AAKASH_SMS_AUTH_TOKEN: optionalNonEmpty,
    AAKASH_SMS_API_URL: z.url().optional(),
    FIREBASE_PROJECT_ID: optionalNonEmpty,
    FIREBASE_CLIENT_EMAIL: z.email().optional(),
    FIREBASE_PRIVATE_KEY: optionalNonEmpty,

    // IVR voice calls for the vendor escalation (Phase 14, read by the worker)
    IVR_PROVIDER: z.enum(ivrProviders).default('DISABLED'),

    // Expo push notifications (Phase 20, read by the worker). Only needed when the Expo project
    // has "enhanced push security" on; without it the push API takes unauthenticated requests.
    EXPO_ACCESS_TOKEN: optionalNonEmpty,

    // Uploads (dispute evidence, product photos). Cloudflare R2 is not wired yet: the API stores
    // files on local disk (default: uploads/ at the API root, apps/api/uploads) and serves them under
    // /uploads. The public base URL defaults to http://localhost:<API_PORT>/uploads; set it to the
    // host's LAN address when a phone or emulator has to load the images.
    UPLOADS_DIR: optionalNonEmpty,
    UPLOADS_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),

    // Vendor wallet top-ups (Phase 12.5).
    WALLET_TOP_UP_MODE: z.enum(walletTopUpModes).default('DISABLED'),

    // Local end-to-end runs: one switch that keeps every third-party call on this machine. SMS and
    // IVR become their MOCK adapters, the worker logs "[MOCK PUSH] …" instead of calling Expo, and
    // the API serves POST /api/test/mock-payment. Refused in production.
    MOCK_SERVICES: z.stringbool().default(false),
  })
  .superRefine((env, ctx) => {
    const requireKeys = (keys: readonly (keyof typeof env)[], reason: string): void => {
      for (const key of keys) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: `Required when ${reason}` });
        }
      }
    };

    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'Must differ from JWT_ACCESS_SECRET',
      });
    }

    // A token-signing key is never also a payment gateway key: leaking one must not expose the other.
    for (const jwtKey of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      for (const gatewayKey of ['ESEWA_SECRET_KEY', 'KHALTI_SECRET_KEY'] as const) {
        if (env[jwtKey] === env[gatewayKey]) {
          ctx.addIssue({
            code: 'custom',
            path: [jwtKey],
            message: `Must differ from ${gatewayKey}`,
          });
        }
      }
    }

    if (env.KAFKA_SASL_MECHANISM !== undefined) {
      requireKeys(['KAFKA_SASL_USERNAME', 'KAFKA_SASL_PASSWORD'], 'KAFKA_SASL_MECHANISM is set');
    }

    if (env.MOCK_SERVICES && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['MOCK_SERVICES'],
        message: 'Mock adapters and the test routes are not allowed in production',
      });
    }

    if (env.WALLET_TOP_UP_MODE === 'MOCK' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['WALLET_TOP_UP_MODE'],
        message: 'MOCK credits wallets without a payment; it is not allowed in production',
      });
    }

    if (env.IVR_PROVIDER === 'MOCK' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['IVR_PROVIDER'],
        message: 'MOCK only logs calls; it is not allowed in production',
      });
    }

    switch (env.SMS_PROVIDER) {
      case 'SPARROW':
        requireKeys(
          ['SPARROW_SMS_TOKEN', 'SPARROW_SMS_FROM', 'SPARROW_SMS_API_URL'],
          'SMS_PROVIDER=SPARROW',
        );
        break;
      case 'AAKASH':
        requireKeys(['AAKASH_SMS_AUTH_TOKEN', 'AAKASH_SMS_API_URL'], 'SMS_PROVIDER=AAKASH');
        break;
      case 'FIREBASE':
        requireKeys(
          ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'],
          'SMS_PROVIDER=FIREBASE',
        );
        break;
      case 'MOCK':
        if (env.NODE_ENV === 'production') {
          ctx.addIssue({
            code: 'custom',
            path: ['SMS_PROVIDER'],
            message: 'MOCK only prints codes to the log; it is not allowed in production',
          });
        }
        break;
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class InvalidEnvError extends Error {
  constructor(details: string) {
    super(`Invalid environment configuration:\n${details}`);
    this.name = 'InvalidEnvError';
  }
}

/**
 * Validates a raw environment map (typically `process.env`).
 * Empty strings are treated as unset so `.env.example` placeholders fail loudly.
 * With MOCK_SERVICES on, SMS_PROVIDER and IVR_PROVIDER are answered as MOCK whatever they are set
 * to, so a local run can never send a billed SMS or place a call.
 */
export function parseServerEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const result = serverEnvSchema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new InvalidEnvError(z.prettifyError(result.error));
  }
  return mockServicesEnabled(result.data)
    ? { ...result.data, SMS_PROVIDER: 'MOCK', IVR_PROVIDER: 'MOCK' }
    : result.data;
}

/** MOCK_SERVICES, and never in production (the schema refuses that combination as well). */
export function mockServicesEnabled(env: Pick<ServerEnv, 'MOCK_SERVICES' | 'NODE_ENV'>): boolean {
  return env.MOCK_SERVICES && env.NODE_ENV !== 'production';
}

function withoutEmpty(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
}

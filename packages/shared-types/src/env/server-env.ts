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

/** Step 7.1 (decided 2026-10-15): Amazon SES over SMTP; MOCK logs; DISABLED sends nothing. */
export const mailProviders = ['SES_SMTP', 'MOCK', 'DISABLED'] as const;
export type IvrProvider = (typeof ivrProviders)[number];

/**
 * Where uploaded files live (SPEC infrastructure section 3). S3 is any S3-compatible bucket
 * (Cloudflare R2, AWS S3). LOCAL writes to the API host's disk and serves the public files itself:
 * development and tests only, refused in production.
 */
export const storageDrivers = ['LOCAL', 'S3'] as const;
export type StorageDriver = (typeof storageDrivers)[number];

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

/** An exact browser origin: scheme, host and optional port, nothing after it. */
export const corsOriginSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      // The URL parser accepts a literal * as a host name: an allowlist entry is never a pattern.
      return (
        !value.includes('*') &&
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === value
      );
    } catch {
      return false;
    }
  },
  { message: 'Must be an origin such as https://admin.hamropasal.np (no path, no wildcard)' },
);

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

    // Email (step 7.1, read by the worker for queued exports). SES_SMTP needs the SES SMTP
    // endpoint of the region (email-smtp.<region>.amazonaws.com), SMTP credentials made in the
    // SES console (not the IAM access key) and a verified sender.
    MAIL_PROVIDER: z.enum(mailProviders).default('DISABLED'),
    SES_SMTP_HOST: optionalNonEmpty,
    SES_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SES_SMTP_USER: optionalNonEmpty,
    SES_SMTP_PASSWORD: optionalNonEmpty,
    MAIL_FROM: z.email().optional(),
    // Step 7.6: where the API is reached from outside, for the link in a queued export's email
    // (`<base>/api/vendor/exports/<id>/download`). Defaults to http://localhost:<API_PORT>.
    PUBLIC_API_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Step 7.7: the Seller app's store page, sent in the SMS that invites an admin-onboarded shop.
    SELLER_APP_URL: z
      .url({ protocol: /^https?$/ })
      .default('https://play.google.com/store/apps/details?id=com.hamro.pasal.seller'),

    // Uploads (dispute evidence, product photos). Cloudflare R2 is not wired yet: the API stores
    // files on local disk (default: uploads/ at the API root, apps/api/uploads) and serves them under
    // /uploads. The public base URL defaults to http://localhost:<API_PORT>/uploads; set it to the
    // host's LAN address when a phone or emulator has to load the images.
    UPLOADS_DIR: optionalNonEmpty,
    UPLOADS_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // LOCAL only: where private documents (KYC) are kept. Never inside UPLOADS_DIR, which is
    // served. Default: uploads-private/ at the API root.
    UPLOADS_PRIVATE_DIR: optionalNonEmpty,

    // Phase 34: the S3-compatible buckets (STORAGE_DRIVER=S3). Two buckets: the public one is
    // read through S3_PUBLIC_BASE_URL (the CDN or the bucket's public domain); the private one
    // (KYC documents) has no public access and is read only through the API.
    STORAGE_DRIVER: z.enum(storageDrivers).default('LOCAL'),
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    S3_REGION: nonEmpty.default('auto'),
    S3_ACCESS_KEY_ID: optionalNonEmpty,
    S3_SECRET_ACCESS_KEY: optionalNonEmpty,
    S3_PUBLIC_BUCKET: optionalNonEmpty,
    S3_PRIVATE_BUCKET: optionalNonEmpty,
    S3_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),

    // Vendor wallet top-ups (Phase 12.5).
    WALLET_TOP_UP_MODE: z.enum(walletTopUpModes).default('DISABLED'),

    // Browser origins other than the API's own that may call it (comma-separated, exact
    // origins, never a wildcard). Empty by default: the admin dashboard is served from the
    // API's origin and the mobile apps are not browsers, so nothing needs CORS.
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((list) =>
        list
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== ''),
      )
      .pipe(z.array(corsOriginSchema)),

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

    if (
      env.NODE_ENV === 'production' &&
      env.CORS_ALLOWED_ORIGINS.some((origin) => !origin.startsWith('https://'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: 'Only https origins may call the API in production',
      });
    }
    if (env.STORAGE_DRIVER === 'S3') {
      requireKeys(
        ['S3_PUBLIC_BUCKET', 'S3_PRIVATE_BUCKET', 'S3_PUBLIC_BASE_URL'],
        'STORAGE_DRIVER=S3',
      );
      if (env.S3_PUBLIC_BUCKET !== undefined && env.S3_PUBLIC_BUCKET === env.S3_PRIVATE_BUCKET) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_PRIVATE_BUCKET'],
          message: 'KYC documents need their own bucket, without public access',
        });
      }
      // Both or neither: without them the SDK's own credential chain is used (an instance role).
      if ((env.S3_ACCESS_KEY_ID === undefined) !== (env.S3_SECRET_ACCESS_KEY === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_SECRET_ACCESS_KEY'],
          message: 'Set S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together',
        });
      }
      if (
        env.NODE_ENV === 'production' &&
        env.S3_PUBLIC_BASE_URL !== undefined &&
        !env.S3_PUBLIC_BASE_URL.startsWith('https://')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_PUBLIC_BASE_URL'],
          message: 'Public files are served over https in production',
        });
      }
    } else if (env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message:
          'LOCAL keeps uploads on the disk of the API host; production needs STORAGE_DRIVER=S3',
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

    if (env.MAIL_PROVIDER === 'SES_SMTP') {
      requireKeys(
        ['SES_SMTP_HOST', 'SES_SMTP_USER', 'SES_SMTP_PASSWORD', 'MAIL_FROM'],
        'MAIL_PROVIDER=SES_SMTP',
      );
    }
    if (env.MAIL_PROVIDER === 'MOCK' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_PROVIDER'],
        message: 'MOCK only logs emails; it is not allowed in production',
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
 * With MOCK_SERVICES on, SMS_PROVIDER, IVR_PROVIDER and MAIL_PROVIDER are answered as MOCK whatever they are set
 * to, so a local run can never send a billed SMS or place a call.
 */
export function parseServerEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const result = serverEnvSchema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new InvalidEnvError(z.prettifyError(result.error));
  }
  return mockServicesEnabled(result.data)
    ? { ...result.data, SMS_PROVIDER: 'MOCK', IVR_PROVIDER: 'MOCK', MAIL_PROVIDER: 'MOCK' }
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

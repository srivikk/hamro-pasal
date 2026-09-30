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

    // Dispute evidence uploads. Cloudflare R2 is not wired yet: the API stores files on local disk
    // (default <os tmpdir>/uploads, i.e. /tmp/uploads on Linux/macOS) and serves them under
    // /uploads. The public base URL defaults to http://localhost:<API_PORT>/uploads; set it to the
    // host's LAN address when a phone or emulator has to load the images.
    UPLOADS_DIR: optionalNonEmpty,
    UPLOADS_PUBLIC_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
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

    if (env.KAFKA_SASL_MECHANISM !== undefined) {
      requireKeys(['KAFKA_SASL_USERNAME', 'KAFKA_SASL_PASSWORD'], 'KAFKA_SASL_MECHANISM is set');
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
 */
export function parseServerEnv(source: Readonly<Record<string, string | undefined>>): ServerEnv {
  const result = serverEnvSchema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new InvalidEnvError(z.prettifyError(result.error));
  }
  return result.data;
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

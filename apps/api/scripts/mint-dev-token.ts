/**
 * Local development only: prints a valid 15-minute access token for a seeded dev user, so the
 * mobile app and API tools can call authenticated routes before OTP login exists.
 *
 *   pnpm --filter @hamro-pasal/api token:dev                         # Aarav (CUSTOMER)
 *   pnpm --filter @hamro-pasal/api token:dev -- --phone 9800000011   # Thamel Kirana Pasal (VENDOR)
 *
 * Reads JWT_ACCESS_SECRET and DATABASE_URL from the root .env. The token alone goes to stdout (so
 * `TOKEN=$(...)` works); details go to stderr. Refuses to run with NODE_ENV=production.
 */
import { parseArgs } from 'node:util';

import { createDatabase, users, type Database } from '@hamro-pasal/db';
import { normalizeNepalPhone, type UserRole } from '@hamro-pasal/shared-types';
import { eq } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { signAccessToken } from '../src/auth/access-token';

/** Aarav Shrestha, the seeded CUSTOMER (packages/db/src/scripts/seed.ts). */
export const DEFAULT_DEV_PHONE = '+9779800000001';

export interface MintedDevToken {
  readonly token: string;
  readonly userId: string;
  readonly role: UserRole;
  readonly phone: string;
  readonly expiresAt: Date;
}

/** Looks the user up by phone and signs an access token exactly as the API verifies it. */
export async function mintDevToken(
  db: Database,
  secret: string,
  phone: string,
): Promise<MintedDevToken> {
  const e164 = normalizeNepalPhone(phone);
  const [user] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.phone, e164));
  if (user === undefined) {
    throw new Error(`No user with phone ${e164}. Seed the dev database first: pnpm db:seed`);
  }

  const token = signAccessToken({ userId: user.id, role: user.role }, secret);
  const decoded = jwt.decode(token);
  if (decoded === null || typeof decoded === 'string' || decoded.exp === undefined) {
    throw new Error('Signed token has no expiry');
  }
  return {
    token,
    userId: user.id,
    role: user.role,
    phone: e164,
    expiresAt: new Date(decoded.exp * 1000),
  };
}

const scriptEnvSchema = z.object({
  NODE_ENV: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32, 'must be set in .env (at least 32 characters)'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL in .env' }),
});

const USAGE = `Usage: token:dev [-- --phone <nepal mobile>]
  Prints a 15-minute access token for a seeded dev user (default ${DEFAULT_DEV_PHONE}, CUSTOMER).
  Seeded phones: +9779800000001/02 CUSTOMER, +9779800000011/12/13 VENDOR,
                 +9779800000021 DRIVER, +9779800000099 SUPER_ADMIN.
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    // pnpm forwards a literal "--" separator (`pnpm token:dev -- --phone ...`); ignore it.
    args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
    options: {
      phone: { type: 'string', short: 'p', default: DEFAULT_DEV_PHONE },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stderr.write(USAGE);
    return;
  }

  const env = scriptEnvSchema.safeParse(process.env);
  if (!env.success) {
    // Name the offending keys only; never echo secret values.
    const problems = env.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }
  if (env.data.NODE_ENV === 'production') {
    throw new Error('Refusing to mint dev tokens with NODE_ENV=production');
  }

  const db = createDatabase(env.data.DATABASE_URL, { max: 1 });
  try {
    const minted = await mintDevToken(db, env.data.JWT_ACCESS_SECRET, values.phone);
    process.stderr.write(
      `[token:dev] ${minted.role} ${minted.phone} (user ${minted.userId}), ` +
        `expires ${minted.expiresAt.toISOString()}\n`,
    );
    process.stdout.write(`${minted.token}\n`);
  } finally {
    await db.$client.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`[token:dev] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

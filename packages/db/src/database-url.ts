import { z } from 'zod';

const databaseUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/** Reads DATABASE_URL only, so DB tooling does not require the full server env. */
export function requireDatabaseUrl(): string {
  const result = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  if (!result.success) {
    throw new Error(
      'DATABASE_URL must be set to a postgres:// or postgresql:// URL (see .env.example)',
    );
  }
  return result.data;
}

/** Redacts the password for logging. */
export function describeDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
}

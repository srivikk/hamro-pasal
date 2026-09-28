import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` diffs the TypeScript schema offline, so it needs no database connection.
// Apply migrations with `pnpm db:migrate` (src/scripts/migrate.ts), not `drizzle-kit push`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  extensionsFilters: ['postgis'],
  strict: true,
  verbose: true,
});

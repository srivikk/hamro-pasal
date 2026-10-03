/**
 * True if `error` (or any error in its `cause` chain; Drizzle wraps driver errors) is a
 * PostgreSQL unique violation (SQLSTATE 23505) on the named constraint.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isConstraintViolation(error, '23505', constraint);
}

/** The same for a foreign-key violation (SQLSTATE 23503) on the named constraint. */
export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  return isConstraintViolation(error, '23503', constraint);
}

function isConstraintViolation(error: unknown, sqlState: string, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const candidate = current as Error & { code?: unknown; constraint?: unknown };
    if (candidate.code === sqlState && candidate.constraint === constraint) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

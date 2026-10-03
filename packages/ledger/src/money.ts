/**
 * All ledger arithmetic is done in integer paisa (1 NPR = 100 paisa) so splits and balance checks
 * are exact. NPR values only exist at the database/API boundary (numeric(12,2) <-> number).
 */
export function toPaisa(npr: number): number {
  const paisa = Math.round(npr * 100);
  if (!Number.isSafeInteger(paisa) || Math.abs(npr * 100 - paisa) > 1e-6) {
    throw new RangeError(`${String(npr)} NPR is not a whole number of paisa`);
  }
  return paisa;
}

export function toNpr(paisa: number): number {
  if (!Number.isSafeInteger(paisa)) {
    throw new RangeError(`${String(paisa)} is not an integer paisa amount`);
  }
  return paisa / 100;
}

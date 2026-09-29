/**
 * NPR amounts are summed in integer paisa (1 NPR = 100 paisa), matching the API's
 * `toPaisa` / `toNpr`, so totals never pick up binary floating-point drift (0.1 + 0.2).
 */
export function toPaisa(npr: number): number {
  return Math.round(npr * 100);
}

export function toNpr(paisa: number): number {
  return paisa / 100;
}

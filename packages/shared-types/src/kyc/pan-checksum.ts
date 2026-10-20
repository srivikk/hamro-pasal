/**
 * ISO/IEC 7064 MOD 11-2, the "pure" check-character system with radix 2: for each digit,
 * `p = ((p + digit) * 2) mod 11`; the check value is `(12 - p) mod 11`, written `X` when it is 10.
 *
 * Applied to a Nepal PAN (decided by the user 2026-10-21): the first eight digits are the payload
 * and the ninth is the check digit. **The IRD has not published a check-digit rule for PANs** (a
 * search found none; the "IRD" MOD 11 rules in circulation are New Zealand's), so the API enforces
 * this only when `PAN_CHECKSUM_ENFORCED=true`, which is off by default: until the rule is
 * confirmed, enforcing it could refuse a real vendor's valid PAN.
 */

/** The MOD 11-2 check value (0–10) of a string of ASCII digits. */
export function mod11_2CheckValue(payload: string): number {
  if (!/^[0-9]+$/.test(payload)) throw new Error('MOD 11-2 is computed over ASCII digits only');
  let p = 0;
  for (const char of payload) {
    p = ((p + Number(char)) * 2) % 11;
  }
  return (12 - p) % 11;
}

/** The check character: a digit, or `X` for 10. */
export function mod11_2CheckCharacter(payload: string): string {
  const value = mod11_2CheckValue(payload);
  return value === 10 ? 'X' : String(value);
}

/**
 * True when a 9-digit PAN's last digit is the MOD 11-2 check digit of its first eight. A PAN
 * whose check value would be 10 (`X`) can never be valid, since a PAN is digits only.
 */
export function isPanChecksumValid(pan: string): boolean {
  if (!/^[0-9]{9}$/.test(pan)) return false;
  return mod11_2CheckCharacter(pan.slice(0, 8)) === pan.slice(8);
}

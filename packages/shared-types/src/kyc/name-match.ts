/*
 * Fuzzy comparison of the business name the IRD holds for a PAN with the name a vendor gave us
 * (its legal name, else its business name). Used by the IRD verification worker: a score at or
 * above IRD_NAME_MATCH_THRESHOLD verifies the PAN automatically, anything below goes to manual
 * review. Pure, so the admin dashboard can show the same score the worker used.
 *
 * Method (a "token set ratio"):
 * 1. normalise both names: lower case, `&` → `and`, punctuation and repeated spaces removed, and
 *    the legal-form words that vary between registrations dropped ("pvt", "ltd", "private",
 *    "limited", "co", "company", "p");
 * 2. compare (a) the two token strings and (b) the shared tokens against each full string, each
 *    by normalised Levenshtein similarity, and take the best: so "Thamel Kirana Pasal" matches
 *    "Thamel Kirana Pasal Pvt. Ltd." and word order does not matter.
 */

/** At or above this score (0–1) the names are taken to be the same business. */
export const IRD_NAME_MATCH_THRESHOLD = 0.85;

const LEGAL_FORM_WORDS = new Set([
  'pvt',
  'private',
  'ltd',
  'limited',
  'co',
  'company',
  'p',
  'l',
  'the',
]);

/** Lower case, `&` as "and", letters and digits only (any script), legal-form words removed. */
export function normaliseBusinessName(name: string): string[] {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word !== '' && !LEGAL_FORM_WORDS.has(word));
}

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** User-perceived characters: a Devanagari consonant with its vowel sign is one, not two. */
export function graphemes(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), (part) => part.segment);
}

/** Levenshtein distance by grapheme cluster, two rows of memory. */
export function levenshtein(a: string, b: string): number {
  const left = graphemes(a);
  const right = graphemes(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** 1 for equal strings, 0 for nothing in common; two empty strings are not a match. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(graphemes(a).length, graphemes(b).length);
  if (longest === 0) return 0;
  return 1 - levenshtein(a, b) / longest;
}

/** The token set ratio of two business names, 0–1, rounded to three decimals. */
export function businessNameSimilarity(a: string, b: string): number {
  const left = [...new Set(normaliseBusinessName(a))].sort();
  const right = [...new Set(normaliseBusinessName(b))].sort();
  if (left.length === 0 || right.length === 0) return 0;
  const shared = left.filter((word) => right.includes(word));
  const onlyLeft = left.filter((word) => !right.includes(word));
  const onlyRight = right.filter((word) => !left.includes(word));
  const base = shared.join(' ');
  const withLeft = [base, ...onlyLeft].filter((part) => part !== '').join(' ');
  const withRight = [base, ...onlyRight].filter((part) => part !== '').join(' ');
  const scores = [similarity(left.join(' '), right.join(' ')), similarity(withLeft, withRight)];
  // The shared words alone count only when they are most of each name, so one common word
  // ("Pasal") never makes two different shops a match.
  if (shared.length > 0 && onlyLeft.length === 0) scores.push(similarity(base, withRight));
  if (shared.length > 0 && onlyRight.length === 0) scores.push(similarity(base, withLeft));
  return Math.round(Math.max(...scores) * 1000) / 1000;
}

/** The best score against any of the vendor's names (legal name, business name). */
export function bestBusinessNameMatch(
  irdName: string,
  vendorNames: readonly (string | null)[],
): number {
  const scores = vendorNames
    .filter((name): name is string => name !== null && name.trim() !== '')
    .map((name) => businessNameSimilarity(irdName, name));
  return scores.length === 0 ? 0 : Math.max(...scores);
}

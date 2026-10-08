import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as fontkit from 'fontkit';

/**
 * Where the invoice fonts live: `assets/fonts/` at the API root (apps/api/assets/fonts). This file
 * sits in src/invoices (tsx) or dist/invoices (node), two levels below that root.
 */
export const DEFAULT_INVOICE_FONT_DIR = resolve(__dirname, '..', '..', 'assets', 'fonts');

/** Noto Sans Devanagari (SIL Open Font License). Required for Nepali text on an invoice. */
export const DEVANAGARI_REGULAR_FILE = 'NotoSansDevanagari-Regular.ttf';
/** Optional: headings in Devanagari are drawn with the regular weight without it. */
export const DEVANAGARI_BOLD_FILE = 'NotoSansDevanagari-Bold.ttf';

/** One weight of the Devanagari font: the file to embed, its metrics and what it can draw. */
export interface DevanagariFace {
  readonly data: Buffer;
  /** Height above the baseline, in ems. */
  readonly ascent: number;
  /** Depth below the baseline, in ems (positive). */
  readonly descent: number;
  /** Baseline to baseline, in ems. */
  readonly lineHeight: number;
  covers(codePoint: number): boolean;
}

export interface InvoiceFonts {
  readonly regular: DevanagariFace;
  readonly bold: DevanagariFace;
}

/** No invoice may be printed without the Devanagari font where one is required (production). */
export class InvoiceFontUnavailableError extends Error {
  constructor(readonly directory: string) {
    super(`${DEVANAGARI_REGULAR_FILE} is missing from ${directory}: invoices cannot be printed`);
    this.name = 'InvoiceFontUnavailableError';
  }
}

function loadFace(path: string): DevanagariFace {
  const data = readFileSync(path);
  const font = fontkit.create(data);
  if (!('unitsPerEm' in font)) throw new Error(`${path} is a font collection, not a single font`);
  const em = font.unitsPerEm;
  return {
    data,
    ascent: font.ascent / em,
    descent: -font.descent / em,
    lineHeight: (font.ascent - font.descent + font.lineGap) / em,
    covers: (codePoint) => font.hasGlyphForCodePoint(codePoint),
  };
}

/**
 * Reads the Devanagari font from `directory`. Null when the regular weight is not there: the
 * caller then prints Latin text only (development) or refuses to print (production).
 */
export function loadInvoiceFonts(directory = DEFAULT_INVOICE_FONT_DIR): InvoiceFonts | null {
  const regularPath = join(directory, DEVANAGARI_REGULAR_FILE);
  if (!existsSync(regularPath)) return null;
  const regular = loadFace(regularPath);
  const boldPath = join(directory, DEVANAGARI_BOLD_FILE);
  return { regular, bold: existsSync(boldPath) ? loadFace(boldPath) : regular };
}

export type TextScript = 'latin' | 'devanagari';

export interface ScriptRun {
  readonly script: TextScript;
  readonly text: string;
}

const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;

/** What the built-in PDF fonts (WinAnsi) draw: printable ASCII and Latin-1. */
const isLatin = (codePoint: number): boolean =>
  (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff);

/**
 * Splits text into runs that one font can draw. Noto Sans Devanagari has no Latin letters and the
 * built-in fonts have no Devanagari, so a line such as "श्रेष्ठ Traders" needs both.
 *
 * Latin-1 goes to the built-in font; anything else the Devanagari face covers goes to it (the
 * joiners stay inside a Devanagari run, where they steer conjuncts). A character neither can draw
 * becomes "?", so the gap is visible and never silently dropped.
 */
export function splitByScript(text: string, face: DevanagariFace | null): ScriptRun[] {
  const runs: { script: TextScript; text: string }[] = [];
  const push = (script: TextScript, piece: string) => {
    const last = runs.at(-1);
    if (last?.script === script) last.text += piece;
    else runs.push({ script, text: piece });
  };
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isLatin(codePoint)) {
      push('latin', character);
    } else if (codePoint === ZERO_WIDTH_JOINER || codePoint === ZERO_WIDTH_NON_JOINER) {
      if (runs.at(-1)?.script === 'devanagari') push('devanagari', character);
    } else if (face?.covers(codePoint) === true) {
      push('devanagari', character);
    } else {
      push('latin', '?');
    }
  }
  return runs;
}

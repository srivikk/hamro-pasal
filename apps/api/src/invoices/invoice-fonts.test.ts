import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database, invoices } from '@hamro-pasal/db';
import { NO_AUDIT_CONTEXT } from '@hamro-pasal/shared-types';
import * as fontkit from 'fontkit';
import PDFDocument from 'pdfkit';

import {
  DEFAULT_INVOICE_FONT_DIR,
  InvoiceFontUnavailableError,
  loadInvoiceFonts,
  splitByScript,
  type DevanagariFace,
} from './invoice-fonts';
import { renderInvoicePdf } from './invoice-pdf';
import { VendorInvoiceService } from './vendor-invoice-service';

type InvoiceRow = typeof invoices.$inferSelect;

/** A face that covers the Devanagari block and nothing else, like Noto Sans Devanagari. */
const devanagariOnly: DevanagariFace = {
  data: Buffer.alloc(0),
  ascent: 1,
  descent: 0.4,
  lineHeight: 1.4,
  covers: (codePoint) => codePoint >= 0x900 && codePoint <= 0x97f,
};

describe('splitByScript', () => {
  it('sends Latin text to the built-in font and Devanagari to its own', () => {
    expect(splitByScript('श्रेष्ठ Traders Pvt. Ltd.', devanagariOnly)).toEqual([
      { script: 'devanagari', text: 'श्रेष्ठ' },
      { script: 'latin', text: ' Traders Pvt. Ltd.' },
    ]);
    expect(splitByScript('Ward 26, काठमाडौं', devanagariOnly)).toEqual([
      { script: 'latin', text: 'Ward 26, ' },
      { script: 'devanagari', text: 'काठमाडौं' },
    ]);
  });

  it('keeps Devanagari digits and the danda with the Devanagari run, ASCII digits with Latin', () => {
    expect(splitByScript('वडा २६।', devanagariOnly)).toEqual([
      { script: 'devanagari', text: 'वडा' },
      { script: 'latin', text: ' ' },
      { script: 'devanagari', text: '२६।' },
    ]);
    expect(splitByScript('26', devanagariOnly)).toEqual([{ script: 'latin', text: '26' }]);
  });

  it('keeps a joiner inside a Devanagari run and drops a stray one', () => {
    expect(splitByScript('क्‍ष', devanagariOnly)).toEqual([{ script: 'devanagari', text: 'क्‍ष' }]);
    expect(splitByScript('A‍B', devanagariOnly)).toEqual([{ script: 'latin', text: 'AB' }]);
  });

  it('shows what neither font can draw as "?", and everything non-Latin without a face', () => {
    expect(splitByScript('茶 Tea', devanagariOnly)).toEqual([{ script: 'latin', text: '? Tea' }]);
    expect(splitByScript('चिया Tea', null)).toEqual([{ script: 'latin', text: '???? Tea' }]);
  });
});

describe('loadInvoiceFonts', () => {
  it('answers null for a directory without the font', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hamro-pasal-fonts-'));
    try {
      expect(loadInvoiceFonts(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true });
    }
  });
});

const installed = loadInvoiceFonts();
// The font is a server asset (apps/api/assets/fonts), not source: without it these cannot run.
const withFont = installed === null ? describe.skip : describe;

const invoice = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  document_type: 'INVOICE',
  vendor_id: '44444444-4444-4444-8444-444444444444',
  order_id: '22222222-2222-4222-8222-222222222222',
  customer_id: '55555555-5555-4555-8555-555555555555',
  fiscal_year: '2082/083',
  bill_number: 142,
  invoice_sequence: 'HP-2082-000142',
  issued_at: new Date('2025-10-08T06:00:00.000Z'),
  issued_date_bs: '2082-06-22',
  subtotal_npr: 1130,
  discount_npr: 0,
  delivery_charge_npr: 0,
  grand_total_npr: 1130,
  seller_name: 'श्रेष्ठ किराना पसल Pvt. Ltd.',
  seller_address: 'ठमेल मार्ग, काठमाडौं-26',
  seller_phone: '+9779800000011',
  seller_tax_id: '302118845',
  seller_is_vat_registered: true,
  buyer_name: 'सीता गुरुङ',
  payment_method: 'COD',
  taxable_amount_npr: 1000,
  vat_rate_percent: 13,
  vat_amount_npr: 130,
  exempt_amount_npr: 0,
  delivery_charged_by: 'VENDOR',
  amount_in_words: 'Rupees One Thousand One Hundred Thirty Only',
  line_items: [
    {
      line_number: 1,
      line_type: 'ITEM',
      product_name: 'इलाम चिया 500g',
      hs_code: null,
      quantity: 1,
      unit_price_npr: 1130,
      line_discount_npr: 0,
      taxable_amount_npr: 1000,
      vat_rate_percent: 13,
      vat_amount_npr: 130,
      line_total_npr: 1130,
      product_id: '33333333-3333-4333-8333-333333333333',
    },
  ],
  ...overrides,
});

interface DrawnRun {
  readonly font: string;
  readonly text: string;
}

/**
 * Renders the invoice and records every string handed to pdfkit with the font it was drawn in.
 * (An embedded font's text is stored as subset glyph ids, so it cannot be read back from the
 * file's bytes the way the built-in fonts' text can.)
 */
async function drawn(row: InvoiceRow, options: Parameters<typeof renderInvoicePdf>[2] = {}) {
  const runs: DrawnRun[] = [];
  let font = '';
  const proto = PDFDocument.prototype as unknown as {
    font: (this: unknown, name: string, ...rest: unknown[]) => unknown;
    text: (this: unknown, value: string, ...rest: unknown[]) => unknown;
  };
  const realFont = proto.font;
  const realText = proto.text;
  const fontSpy = jest.spyOn(proto, 'font').mockImplementation(function (
    this: unknown,
    name,
    ...rest
  ) {
    font = name;
    return realFont.call(this, name, ...rest);
  });
  const textSpy = jest.spyOn(proto, 'text').mockImplementation(function (
    this: unknown,
    value,
    ...rest
  ) {
    runs.push({ font, text: value });
    return realText.call(this, value, ...rest);
  });
  try {
    const pdf = await renderInvoicePdf(row, 0, options);
    return { pdf, runs, texts: runs.map((run) => run.text) };
  } finally {
    fontSpy.mockRestore();
    textSpy.mockRestore();
  }
}

const DEVANAGARI_TEXT = /[\u0900-\u097f]/;
const LATIN_LETTER = /[A-Za-z]/;

withFont('the installed Noto Sans Devanagari', () => {
  const fonts = installed ?? { regular: devanagariOnly, bold: devanagariOnly };

  it('has no Latin letters (so Latin text must stay with the built-in font) but shapes conjuncts', () => {
    expect(fonts.regular.covers('A'.codePointAt(0) ?? 0)).toBe(false);
    expect(fonts.regular.covers('क'.codePointAt(0) ?? 0)).toBe(true);
    expect(fonts.regular.covers('०'.codePointAt(0) ?? 0)).toBe(true);

    const font = fontkit.create(fonts.regular.data);
    if (!('layout' in font)) throw new Error('expected a single font');
    // क् + ष is one conjunct glyph; the short i matra is drawn before its consonant.
    expect(font.layout('क्ष').glyphs).toHaveLength(1);
    const ki = font.layout('कि').glyphs.map((glyph) => glyph.name);
    expect(ki[0]).toMatch(/iMatra/);
  });

  it('embeds the font and prints the IRD’s Nepali field names beside the English ones', async () => {
    const { pdf, texts } = await drawn(invoice(), { compress: false, fonts });

    expect(pdf.toString('latin1')).toContain('NotoSansDevanagari');
    expect(texts).toContain('आर्थिक वर्ष');
    expect(texts).toContain('बिजक नम्बर');
    expect(texts).toContain('मिति');
    expect(texts).toContain('Fiscal Year / ');
    expect(texts).toContain('2082/083');
  });

  it('draws every Devanagari run with the Devanagari font and every Latin letter with Helvetica', async () => {
    const { runs } = await drawn(invoice(), { compress: false, fonts });

    expect(runs.some((run) => DEVANAGARI_TEXT.test(run.text))).toBe(true);
    for (const run of runs) {
      if (DEVANAGARI_TEXT.test(run.text)) {
        expect(run.font).toMatch(/^InvoiceDevanagari/);
        expect(run.text).not.toMatch(LATIN_LETTER);
      } else {
        expect(run.font).toMatch(/^Helvetica/);
      }
    }
  });

  it('prints Nepali seller, buyer and product names, never as question marks', async () => {
    const { texts } = await drawn(invoice(), { compress: false, fonts });

    expect(texts.join('')).not.toContain('?');
    // The seller's name is a heading (bold); a mixed name is cut where the script changes.
    expect(texts).toContain('श्रेष्ठ किराना पसल ');
    expect(texts).toContain('Pvt. Ltd.');
    expect(texts).toContain('ठमेल मार्ग');
    expect(texts).toContain('काठमाडौं');
    expect(texts).toContain('-26');
    expect(texts).toContain('सीता गुरुङ');
    expect(texts).toContain('इलाम चिया ');
    expect(texts).toContain('500g');
  });

  it('still prints "?" for a script neither font covers', async () => {
    const { texts } = await drawn(invoice({ buyer_name: '茶 Sita' }), { compress: false, fonts });
    expect(texts).toContain('? Sita');
  });

  it('prints no Nepali labels and embeds nothing without the font', async () => {
    const { pdf, texts } = await drawn(invoice(), { compress: false });
    expect(pdf.toString('latin1')).not.toContain('NotoSansDevanagari');
    expect(texts).toContain('Fiscal Year:');
    expect(texts.some((value) => DEVANAGARI_TEXT.test(value))).toBe(false);
  });

  it('is the same bytes for the same invoice, copy and font', async () => {
    const first = await renderInvoicePdf(invoice(), 0, { fonts });
    const again = await renderInvoicePdf(invoice(), 0, { fonts });
    expect(again.equals(first)).toBe(true);
  });

  it('wraps a long Nepali product name inside its column, at its spaces', async () => {
    const name = 'हिमाली जैविक रातो चामल विशेष प्याकेज पाँच किलोग्राम नयाँ बाली';
    const [item] = invoice().line_items;
    if (item === undefined) throw new Error('the fixture has a line');
    const { texts } = await drawn(invoice({ line_items: [{ ...item, product_name: name }] }), {
      compress: false,
      fonts,
    });

    expect(texts).not.toContain(name);
    const pieces = texts.filter((value) => DEVANAGARI_TEXT.test(value) && name.includes(value));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(' ')).toBe(name);
  });

  it('is found in the server assets directory', () => {
    expect(loadInvoiceFonts(DEFAULT_INVOICE_FONT_DIR)).not.toBeNull();
  });
});

describe('printing without the Devanagari font', () => {
  // Any use of the database fails the test: the refusal must come before a lock or a log row.
  const untouchable = new Proxy(
    {},
    {
      get: () => {
        throw new Error('the database was used');
      },
    },
  ) as unknown as Database;
  const actor = {
    kind: 'USER' as const,
    user_id: '55555555-5555-4555-8555-555555555555',
    role: 'VENDOR' as const,
  };

  it('is refused where the font is required (production), before any copy number is taken', async () => {
    const service = new VendorInvoiceService(untouchable, null, true);

    await expect(service.print(actor, invoice().id, NO_AUDIT_CONTEXT)).rejects.toBeInstanceOf(
      InvoiceFontUnavailableError,
    );
  });

  it('goes ahead where it is not required (development), with Latin text only', () => {
    const service = new VendorInvoiceService(untouchable, null, false);

    // It reaches the database: the font was not what stopped it.
    expect(() => service.print(actor, invoice().id, NO_AUDIT_CONTEXT)).toThrow(
      'the database was used',
    );
  });
});

import type { invoices } from '@hamro-pasal/db';
import {
  INVOICE_PLATFORM_DISCLAIMER,
  invoiceCopyLabel,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import PDFDocument from 'pdfkit';

import { splitByScript, type DevanagariFace, type InvoiceFonts } from './invoice-fonts';

type InvoiceRow = typeof invoices.$inferSelect;

export interface InvoicePdfOptions {
  /** Deflate the page streams (the default). Tests switch it off to read the text back. */
  readonly compress?: boolean;
  /**
   * The Devanagari font (Noto Sans Devanagari). With it, Nepali names are drawn and the IRD's
   * Nepali field names are printed beside the English ones (SPEC Nepal section 5). Without it
   * (null, the default) only Latin text can be drawn.
   */
  readonly fonts?: InvoiceFonts | null;
}

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4, in points
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;
const BOTTOM = PAGE_HEIGHT - PAGE_MARGIN - 30; // the footer's line sits below this

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const DEVANAGARI = 'InvoiceDevanagari';
const DEVANAGARI_BOLD = 'InvoiceDevanagari-Bold';

/** Helvetica's metrics in ems (its AFM file): what pdfkit itself lays a Latin line out with. */
const LATIN_METRICS = { ascent: 0.718, descent: 0.207, lineHeight: 1.156 } as const;

/** The IRD's field names (SPEC Nepal section 5), printed beside the English ones. */
const NEPALI_LABELS = {
  fiscalYear: 'आर्थिक वर्ष',
  billNumber: 'बिजक नम्बर',
  date: 'मिति',
} as const;

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  COD: 'Cash on Delivery',
  ESEWA: 'eSewa',
  KHALTI: 'Khalti',
};

const DOCUMENT_TITLES: Record<InvoiceRow['document_type'], string> = {
  INVOICE: 'INVOICE',
  CREDIT_NOTE: 'CREDIT NOTE',
  DEBIT_NOTE: 'DEBIT NOTE',
};

/** "1,02,500.50": two decimals, Nepali grouping (thousand, lakh, crore). */
export function formatInvoiceAmount(npr: number): string {
  const [whole = '0', fraction = '00'] = Math.abs(npr).toFixed(2).split('.');
  const head = whole.slice(0, -3);
  const grouped =
    head === '' ? whole : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`;
  return `${npr < 0 ? '-' : ''}${grouped}.${fraction}`;
}

const NEPAL_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kathmandu',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "2025-10-08 11:45" in Nepal Time. */
export function formatNepalTime(instant: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    NEPAL_TIME.formatToParts(instant).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/**
 * Text as the built-in PDF fonts alone can draw it: Latin only. A character they cannot draw (a
 * name in Devanagari, when no Devanagari font is loaded) is "?" so the gap is visible, never
 * silently dropped.
 */
export function pdfSafeText(text: string): string {
  return splitByScript(text, null)
    .map((run) => run.text)
    .join('');
}

type Align = 'left' | 'right' | 'center';

/** A stretch of one line drawn with one font. */
interface Segment {
  text: string;
  font: string;
  width: number;
}

interface TextLine {
  readonly segments: Segment[];
  width: number;
  /** A line holding Devanagari is taller: its matras rise above and hang below Latin letters. */
  devanagari: boolean;
}

const GRAPHEMES = new Intl.Segmenter('ne', { granularity: 'grapheme' });

/**
 * Lays out and draws text that mixes Devanagari and Latin. pdfkit draws a string with one font,
 * and neither font covers both scripts, so every line is cut into runs per script, each measured
 * and drawn with its own font on one shared baseline. Words wrap at spaces; a single word wider
 * than the column is cut between grapheme clusters, never inside a conjunct.
 */
function mixedText(doc: PDFKit.PDFDocument, fonts: InvoiceFonts | null) {
  let bold = false;
  let size = 9;

  const face = (): DevanagariFace | null =>
    fonts === null ? null : bold ? fonts.bold : fonts.regular;
  const latinFont = () => (bold ? BOLD : REGULAR);
  const fontOf = (script: 'latin' | 'devanagari') =>
    script === 'latin' ? latinFont() : bold ? DEVANAGARI_BOLD : DEVANAGARI;
  const measure = (piece: string, font: string) =>
    doc.font(font).fontSize(size).widthOfString(piece);

  const segmentsOf = (piece: string): Segment[] =>
    splitByScript(piece, face()).map((run) => {
      const font = fontOf(run.script);
      return { text: run.text, font, width: measure(run.text, font) };
    });
  const widthOf = (segments: readonly Segment[]) =>
    segments.reduce((sum, segment) => sum + segment.width, 0);

  const append = (line: TextLine, segments: readonly Segment[]) => {
    for (const segment of segments) {
      const last = line.segments.at(-1);
      if (last?.font === segment.font) last.text += segment.text;
      else line.segments.push({ ...segment });
      line.width += segment.width;
      if (segment.font !== latinFont()) line.devanagari = true;
    }
  };

  /** `maxWidth` null: one line, however long. */
  const layout = (text: string, maxWidth: number | null): TextLine[] => {
    const lines: TextLine[] = [];
    let line: TextLine = { segments: [], width: 0, devanagari: false };
    const breakLine = () => {
      lines.push(line);
      line = { segments: [], width: 0, devanagari: false };
    };
    // A space is drawn in the font of the word before it (both fonts have one), so a Nepali
    // phrase stays one run.
    const spaceAfter = (laid: TextLine): Segment => {
      const font = laid.segments.at(-1)?.font ?? latinFont();
      return { text: ' ', font, width: measure(' ', font) };
    };

    for (const word of text.split(' ')) {
      const segments = segmentsOf(word);
      const width = widthOf(segments);
      const space = spaceAfter(line);
      const gap = line.segments.length === 0 ? 0 : space.width;
      if (maxWidth === null || line.width + gap + width <= maxWidth) {
        if (gap > 0) append(line, [space]);
        append(line, segments);
        continue;
      }
      if (line.segments.length > 0) breakLine();
      if (width <= maxWidth) {
        append(line, segments);
        continue;
      }
      // A word wider than the whole column: cut it between grapheme clusters.
      for (const { segment: cluster } of GRAPHEMES.segment(word)) {
        const piece = segmentsOf(cluster);
        if (line.segments.length > 0 && line.width + widthOf(piece) > maxWidth) breakLine();
        append(line, piece);
      }
    }
    lines.push(line);
    // Joined runs are measured again as they will be drawn (kerning and shaping across the join).
    for (const laid of lines) {
      for (const segment of laid.segments) segment.width = measure(segment.text, segment.font);
      laid.width = widthOf(laid.segments);
    }
    return lines;
  };

  const metricsOf = (line: TextLine) => {
    const tall = line.devanagari ? face() : null;
    return {
      ascent: Math.max(LATIN_METRICS.ascent, tall?.ascent ?? 0) * size,
      lineHeight: Math.max(LATIN_METRICS.lineHeight, tall?.lineHeight ?? 0) * size,
    };
  };

  return {
    style(nextBold: boolean, nextSize: number) {
      bold = nextBold;
      size = nextSize;
    },
    height(text: string, width: number): number {
      return layout(text, width).reduce((sum, line) => sum + metricsOf(line).lineHeight, 0);
    },
    /** Draws the text with its top at `y`; answers the y just below its last line. */
    draw(text: string, x: number, y: number, width: number, align: Align = 'left', wrap = true) {
      let top = y;
      for (const line of layout(text, wrap ? width : null)) {
        const { ascent, lineHeight } = metricsOf(line);
        const slack = width - line.width;
        let at = x + (align === 'right' ? slack : align === 'center' ? slack / 2 : 0);
        for (const segment of line.segments) {
          doc
            .font(segment.font)
            .fontSize(size)
            .text(segment.text, at, top + ascent, { lineBreak: false, baseline: 'alphabetic' });
          at += segment.width;
        }
        top += lineHeight;
      }
      return top;
    },
  };
}

interface Column {
  readonly key: string;
  readonly title: string;
  readonly width: number;
  readonly align: 'left' | 'right';
}

// Widths add up to CONTENT_WIDTH (515.28).
const COLUMNS: readonly Column[] = [
  { key: 'sn', title: 'S.N.', width: 28, align: 'left' },
  { key: 'name', title: 'Particulars', width: 151.28, align: 'left' },
  { key: 'hs', title: 'HS Code', width: 48, align: 'left' },
  { key: 'qty', title: 'Qty', width: 30, align: 'right' },
  { key: 'rate', title: 'Rate', width: 58, align: 'right' },
  { key: 'discount', title: 'Discount', width: 50, align: 'right' },
  { key: 'taxable', title: 'Taxable', width: 58, align: 'right' },
  { key: 'vat', title: 'VAT', width: 44, align: 'right' },
  { key: 'amount', title: 'Amount', width: 48, align: 'right' },
];
const CELL_PADDING = 3;

/**
 * The invoice as a PDF, rendered by the server from the sealed row (decided 2026-10-08: the
 * backend is the only author of the printed document). Nothing is computed here: every figure,
 * the amount in words and the dates are the row's own. The same row, copy number and fonts always
 * give the same bytes.
 *
 * `copyNumber` 0 marks the page ORIGINAL; n marks it COPY OF ORIGINAL (n) (SPEC core 10).
 */
export function renderInvoicePdf(
  invoice: InvoiceRow,
  copyNumber: number,
  options: InvoicePdfOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fonts = options.fonts ?? null;
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      // The footer is written on every page once the page count is known.
      bufferPages: true,
      compress: options.compress ?? true,
      info: {
        Title: `${DOCUMENT_TITLES[invoice.document_type]} ${invoice.invoice_sequence}`,
        Author: fonts === null ? pdfSafeText(invoice.seller_name) : invoice.seller_name,
        Creator: 'Hamro Pasal',
        Producer: 'Hamro Pasal',
        CreationDate: invoice.issued_at,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
    if (fonts !== null) {
      doc.registerFont(DEVANAGARI, fonts.regular.data);
      doc.registerFont(DEVANAGARI_BOLD, fonts.bold.data);
    }
    const text = mixedText(doc, fonts);
    const bilingual = (english: string, nepali: string) =>
      fonts === null ? english : `${english} / ${nepali}`;

    const left = PAGE_MARGIN;
    const right = PAGE_MARGIN + CONTENT_WIDTH;

    // The copy mark, then the seller (SPEC core 10, "Header").
    text.style(true, 9);
    text.draw(invoiceCopyLabel(copyNumber), left, PAGE_MARGIN, CONTENT_WIDTH, 'right');
    text.style(true, 15);
    let y = text.draw(invoice.seller_name, left, PAGE_MARGIN + 14, CONTENT_WIDTH, 'center');
    text.style(false, 9);
    y = text.draw(invoice.seller_address, left, y + 2, CONTENT_WIDTH, 'center');
    y = text.draw(`Phone: ${invoice.seller_phone}`, left, y + 1, CONTENT_WIDTH, 'center');
    text.style(true, 10);
    y = text.draw(
      `${invoice.seller_is_vat_registered ? 'VAT No.' : 'PAN'}: ${invoice.seller_tax_id}`,
      left,
      y + 2,
      CONTENT_WIDTH,
      'center',
    );
    text.style(true, 13);
    const title =
      invoice.document_type === 'INVOICE' && invoice.seller_is_vat_registered
        ? 'TAX INVOICE'
        : DOCUMENT_TITLES[invoice.document_type];
    y = text.draw(title, left, y + 10, CONTENT_WIDTH, 'center');

    // Metadata: the buyer on the left, the bill on the right.
    const metaTop = y + 10;
    // The left block holds the order id on one line; the bilingual labels need a wider right one.
    const leftWidth = CONTENT_WIDTH * (fonts === null ? 0.58 : 0.5);
    const pairs = (
      rows: readonly (readonly [string, string])[],
      x: number,
      width: number,
      labelWidth: number,
    ) => {
      let top = metaTop;
      for (const [label, value] of rows) {
        text.style(true, 9);
        const labelEnd = text.draw(`${label}:`, x, top, labelWidth);
        text.style(false, 9);
        const valueEnd = text.draw(value, x + labelWidth + 2, top, width - labelWidth - 8);
        top = Math.max(labelEnd, valueEnd) + 3;
      }
      return top;
    };
    const leftEnd = pairs(
      [
        ['Buyer', invoice.buyer_name],
        ['Payment', PAYMENT_METHOD_LABELS[invoice.payment_method]],
        ['Order', invoice.order_id],
      ],
      left,
      leftWidth,
      50,
    );
    const rightEnd = pairs(
      [
        ['Invoice No.', invoice.invoice_sequence],
        [bilingual('Bill No.', NEPALI_LABELS.billNumber), String(invoice.bill_number)],
        [bilingual('Fiscal Year', NEPALI_LABELS.fiscalYear), invoice.fiscal_year],
        [bilingual('Date (BS)', NEPALI_LABELS.date), invoice.issued_date_bs],
        ['Date (AD)', `${formatNepalTime(invoice.issued_at)} NPT`],
      ],
      left + leftWidth,
      CONTENT_WIDTH - leftWidth,
      fonts === null ? 64 : 116,
    );

    // The itemised table.
    y = Math.max(leftEnd, rightEnd) + 8;
    const rule = (at: number, weight = 0.5) => {
      doc.moveTo(left, at).lineTo(right, at).lineWidth(weight).stroke();
    };
    const row = (cells: Readonly<Record<string, string>>, bold: boolean) => {
      text.style(bold, 8.5);
      const widthOf = (column: Column) => column.width - 2 * CELL_PADDING;
      const height = Math.max(
        ...COLUMNS.map((column) => text.height(cells[column.key] ?? '', widthOf(column))),
      );
      if (y + height + 2 * CELL_PADDING > BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        if (!bold) {
          header();
          text.style(false, 8.5);
        }
      }
      let x = left;
      for (const column of COLUMNS) {
        text.draw(
          cells[column.key] ?? '',
          x + CELL_PADDING,
          y + CELL_PADDING,
          widthOf(column),
          column.align,
        );
        x += column.width;
      }
      y += height + 2 * CELL_PADDING;
      rule(y, bold ? 1 : 0.25);
    };
    const header = () => {
      rule(y, 1);
      row(Object.fromEntries(COLUMNS.map((column) => [column.key, column.title])), true);
    };
    header();
    for (const item of invoice.line_items) {
      row(
        {
          sn: String(item.line_number),
          name: item.product_name,
          hs: item.hs_code ?? '-',
          qty: String(item.quantity),
          rate: formatInvoiceAmount(item.unit_price_npr),
          discount: formatInvoiceAmount(item.line_discount_npr),
          taxable: formatInvoiceAmount(item.taxable_amount_npr),
          vat: formatInvoiceAmount(item.vat_amount_npr),
          amount: formatInvoiceAmount(item.line_total_npr),
        },
        false,
      );
    }

    // Totals, as stored.
    const totals: (readonly [string, string, boolean])[] = [
      ['Subtotal', formatInvoiceAmount(invoice.subtotal_npr), false],
      ['Discount', formatInvoiceAmount(invoice.discount_npr), false],
      [
        invoice.delivery_charged_by === 'PLATFORM'
          ? 'Delivery charge (Hamro Pasal delivery)'
          : 'Delivery charge',
        formatInvoiceAmount(invoice.delivery_charge_npr),
        false,
      ],
      ['Taxable amount', formatInvoiceAmount(invoice.taxable_amount_npr), false],
      [
        `VAT ${String(invoice.vat_rate_percent)}%`,
        formatInvoiceAmount(invoice.vat_amount_npr),
        false,
      ],
      ['Non-taxable amount', formatInvoiceAmount(invoice.exempt_amount_npr), false],
      ['Grand Total (NPR)', formatInvoiceAmount(invoice.grand_total_npr), true],
    ];
    if (y + totals.length * 14 + 60 > BOTTOM) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
    y += 8;
    for (const [label, value, strong] of totals) {
      text.style(strong, strong ? 10.5 : 9);
      const labelEnd = text.draw(label, right - 260, y, 170, 'right');
      const valueEnd = text.draw(value, right - 86, y, 86 - CELL_PADDING, 'right');
      y = Math.max(labelEnd, valueEnd) + 4;
    }
    y += 6;
    text.style(true, 9);
    text.draw('Amount in words:', left, y, 84);
    text.style(false, 9);
    text.draw(invoice.amount_in_words, left + 86, y, CONTENT_WIDTH - 86);

    // The footer of every page: the disclaimer and the invoice it belongs to.
    const pages = doc.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page += 1) {
      doc.switchToPage(page);
      // Below the body's bottom margin: without this the text would start a new page.
      doc.page.margins.bottom = 0;
      text.style(false, 8);
      text.draw(
        `${INVOICE_PLATFORM_DISCLAIMER}   ${invoice.invoice_sequence} · ${invoiceCopyLabel(copyNumber)} · Page ${String(page + 1)} of ${String(pages.count)}`,
        left,
        PAGE_HEIGHT - PAGE_MARGIN - 12,
        CONTENT_WIDTH,
        'center',
        false,
      );
    }
    doc.end();
  });
}

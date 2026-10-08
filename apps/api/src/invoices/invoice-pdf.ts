import type { invoices } from '@hamro-pasal/db';
import {
  INVOICE_PLATFORM_DISCLAIMER,
  invoiceCopyLabel,
  type PaymentMethod,
} from '@hamro-pasal/shared-types';
import PDFDocument from 'pdfkit';

type InvoiceRow = typeof invoices.$inferSelect;

export interface InvoicePdfOptions {
  /** Deflate the page streams (the default). Tests switch it off to read the text back. */
  readonly compress?: boolean;
}

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4, in points
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;
const BOTTOM = PAGE_HEIGHT - PAGE_MARGIN - 30; // the footer's line sits below this

const REGULAR = 'Helvetica';
const BOLD = 'Helvetica-Bold';

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
 * The built-in PDF fonts cover Latin text only. A character they cannot draw (a product or buyer
 * name in Devanagari) is printed as "?" so the gap is visible, never silently dropped.
 */
export function pdfSafeText(text: string): string {
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
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
 * the amount in words and the dates are the row's own. The same row and copy number always give
 * the same bytes.
 *
 * `copyNumber` 0 marks the page ORIGINAL; n marks it COPY OF ORIGINAL (n) (SPEC core 10).
 */
export function renderInvoicePdf(
  invoice: InvoiceRow,
  copyNumber: number,
  options: InvoicePdfOptions = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      // The footer is written on every page once the page count is known.
      bufferPages: true,
      compress: options.compress ?? true,
      info: {
        Title: `${DOCUMENT_TITLES[invoice.document_type]} ${invoice.invoice_sequence}`,
        Author: pdfSafeText(invoice.seller_name),
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

    const left = PAGE_MARGIN;
    const right = PAGE_MARGIN + CONTENT_WIDTH;
    const line = (
      text: string,
      x: number,
      y: number,
      width: number,
      align: 'left' | 'right' | 'center' = 'left',
    ) => doc.text(pdfSafeText(text), x, y, { width, align });

    // The copy mark, then the seller (SPEC core 10, "Header").
    doc.font(BOLD).fontSize(9);
    line(invoiceCopyLabel(copyNumber), left, PAGE_MARGIN, CONTENT_WIDTH, 'right');
    doc.font(BOLD).fontSize(15);
    line(invoice.seller_name, left, PAGE_MARGIN + 14, CONTENT_WIDTH, 'center');
    doc.font(REGULAR).fontSize(9);
    line(invoice.seller_address, left, doc.y + 2, CONTENT_WIDTH, 'center');
    line(`Phone: ${invoice.seller_phone}`, left, doc.y + 1, CONTENT_WIDTH, 'center');
    doc.font(BOLD).fontSize(10);
    line(
      `${invoice.seller_is_vat_registered ? 'VAT No.' : 'PAN'}: ${invoice.seller_tax_id}`,
      left,
      doc.y + 2,
      CONTENT_WIDTH,
      'center',
    );
    doc.font(BOLD).fontSize(13);
    const title =
      invoice.document_type === 'INVOICE' && invoice.seller_is_vat_registered
        ? 'TAX INVOICE'
        : DOCUMENT_TITLES[invoice.document_type];
    line(title, left, doc.y + 10, CONTENT_WIDTH, 'center');

    // Metadata: the buyer on the left, the bill on the right.
    const metaTop = doc.y + 10;
    // The wider left block holds the order id on one line.
    const leftWidth = CONTENT_WIDTH * 0.58;
    const pairs = (
      rows: readonly (readonly [string, string])[],
      x: number,
      width: number,
      labelWidth: number,
    ) => {
      let y = metaTop;
      for (const [label, value] of rows) {
        doc.font(BOLD).fontSize(9);
        line(`${label}:`, x, y, labelWidth);
        doc.font(REGULAR);
        line(value, x + labelWidth + 2, y, width - labelWidth - 8);
        y = doc.y + 3;
      }
      return y;
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
        ['Bill No.', String(invoice.bill_number)],
        ['Fiscal Year', invoice.fiscal_year],
        ['Date (BS)', invoice.issued_date_bs],
        ['Date (AD)', `${formatNepalTime(invoice.issued_at)} NPT`],
      ],
      left + leftWidth,
      CONTENT_WIDTH - leftWidth,
      64,
    );

    // The itemised table.
    let y = Math.max(leftEnd, rightEnd) + 8;
    const rule = (at: number, weight = 0.5) => {
      doc.moveTo(left, at).lineTo(right, at).lineWidth(weight).stroke();
    };
    const row = (cells: Readonly<Record<string, string>>, bold: boolean) => {
      doc.font(bold ? BOLD : REGULAR).fontSize(8.5);
      const widthOf = (column: Column) => column.width - 2 * CELL_PADDING;
      const height = Math.max(
        ...COLUMNS.map((column) =>
          doc.heightOfString(pdfSafeText(cells[column.key] ?? ''), { width: widthOf(column) }),
        ),
      );
      if (y + height + 2 * CELL_PADDING > BOTTOM) {
        doc.addPage();
        y = PAGE_MARGIN;
        if (!bold) {
          header();
          doc.font(REGULAR).fontSize(8.5);
        }
      }
      let x = left;
      for (const column of COLUMNS) {
        line(
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
      doc.font(strong ? BOLD : REGULAR).fontSize(strong ? 10.5 : 9);
      line(label, right - 260, y, 170, 'right');
      line(value, right - 86, y, 86 - CELL_PADDING, 'right');
      y = doc.y + 4;
    }
    y += 6;
    doc.font(BOLD).fontSize(9);
    line('Amount in words:', left, y, 84);
    doc.font(REGULAR);
    line(invoice.amount_in_words, left + 86, y, CONTENT_WIDTH - 86);

    // The footer of every page: the disclaimer and the invoice it belongs to.
    const pages = doc.bufferedPageRange();
    for (let page = pages.start; page < pages.start + pages.count; page += 1) {
      doc.switchToPage(page);
      // Below the body's bottom margin: without this the text would start a new page.
      doc.page.margins.bottom = 0;
      doc.font(REGULAR).fontSize(8);
      doc.text(
        pdfSafeText(
          `${INVOICE_PLATFORM_DISCLAIMER}   ${invoice.invoice_sequence} · ${invoiceCopyLabel(copyNumber)} · Page ${String(page + 1)} of ${String(pages.count)}`,
        ),
        left,
        PAGE_HEIGHT - PAGE_MARGIN - 12,
        { width: CONTENT_WIDTH, align: 'center', lineBreak: false },
      );
    }
    doc.end();
  });
}

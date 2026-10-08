import type { invoices } from '@hamro-pasal/db';
import { INVOICE_PLATFORM_DISCLAIMER, type InvoiceLineItem } from '@hamro-pasal/shared-types';

import { formatInvoiceAmount, formatNepalTime, pdfSafeText, renderInvoicePdf } from './invoice-pdf';

type InvoiceRow = typeof invoices.$inferSelect;

const line = (overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  line_number: 1,
  line_type: 'ITEM',
  product_name: 'Basmati Rice 5kg',
  hs_code: null,
  quantity: 1,
  unit_price_npr: 1130,
  line_discount_npr: 0,
  taxable_amount_npr: 1000,
  vat_rate_percent: 13,
  vat_amount_npr: 130,
  line_total_npr: 1130,
  product_id: '33333333-3333-4333-8333-333333333333',
  ...overrides,
});

/** SPEC verification 12's invoice: 1130 of goods (1000.00 + 130.00) and the shop's own delivery. */
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
  delivery_charge_npr: 50,
  grand_total_npr: 1180,
  seller_name: 'Thamel Kirana Pasal Pvt. Ltd.',
  seller_address: 'Thamel Marg, Kathmandu-26',
  seller_phone: '+9779800000011',
  seller_tax_id: '302118845',
  seller_is_vat_registered: true,
  buyer_name: 'Aarav Shrestha',
  payment_method: 'COD',
  taxable_amount_npr: 1044.25,
  vat_rate_percent: 13,
  vat_amount_npr: 135.75,
  exempt_amount_npr: 0,
  delivery_charged_by: 'VENDOR',
  amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
  line_items: [
    line(),
    line({
      line_number: 2,
      line_type: 'DELIVERY',
      product_name: 'Delivery charge',
      unit_price_npr: 50,
      taxable_amount_npr: 44.25,
      vat_amount_npr: 5.75,
      line_total_npr: 50,
      product_id: null,
    }),
  ],
  ...overrides,
});

/**
 * The text a PDF draws, in drawing order, one entry per text run. Only for PDFs rendered with
 * `compress: false`: the page streams are then plain, with each run as hex strings in a TJ array.
 */
function textRuns(pdf: Buffer): string[] {
  const runs: string[] = [];
  for (const run of pdf.toString('latin1').matchAll(/\[((?:<[0-9a-f]*>|[-0-9. ]+)+)\] TJ/g)) {
    runs.push(
      [...(run[1] ?? '').matchAll(/<([0-9a-f]*)>/g)]
        .map((piece) => Buffer.from(piece[1] ?? '', 'hex').toString('latin1'))
        .join(''),
    );
  }
  return runs;
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

const readable = (row: InvoiceRow, copyNumber = 0) =>
  renderInvoicePdf(row, copyNumber, { compress: false }).then(textRuns);

describe('formatInvoiceAmount', () => {
  it('writes two decimals with the Nepali grouping', () => {
    expect(formatInvoiceAmount(0)).toBe('0.00');
    expect(formatInvoiceAmount(5.5)).toBe('5.50');
    expect(formatInvoiceAmount(999)).toBe('999.00');
    expect(formatInvoiceAmount(1180)).toBe('1,180.00');
    expect(formatInvoiceAmount(102500.5)).toBe('1,02,500.50');
    expect(formatInvoiceAmount(12345678.9)).toBe('1,23,45,678.90');
  });
});

describe('formatNepalTime', () => {
  it('writes the instant in Nepal Time (UTC+05:45), across the day boundary', () => {
    expect(formatNepalTime(new Date('2025-10-08T06:00:00.000Z'))).toBe('2025-10-08 11:45');
    expect(formatNepalTime(new Date('2025-10-08T18:15:00.000Z'))).toBe('2025-10-09 00:00');
  });
});

describe('pdfSafeText', () => {
  it('keeps Latin text and shows what the built-in fonts cannot draw as "?"', () => {
    expect(pdfSafeText('Café Rs. 100 · 50%')).toBe('Café Rs. 100 · 50%');
    expect(pdfSafeText('वाइ वाइ Noodles')).toBe('??? ??? Noodles');
  });
});

describe('renderInvoicePdf', () => {
  it('answers a PDF file', async () => {
    const pdf = await renderInvoicePdf(invoice(), 0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
    expect(pageCount(pdf)).toBe(1);
  });

  it('prints the IRD header: seller, PAN / VAT number, buyer, invoice number and both dates', async () => {
    const runs = await readable(invoice());

    expect(runs).toEqual(
      expect.arrayContaining([
        'Thamel Kirana Pasal Pvt. Ltd.',
        'Thamel Marg, Kathmandu-26',
        'Phone: +9779800000011',
        'VAT No.: 302118845',
        'TAX INVOICE',
        'Aarav Shrestha',
        'Cash on Delivery',
        '22222222-2222-4222-8222-222222222222',
        'HP-2082-000142',
        '142',
        '2082/083',
        '2082-06-22',
        '2025-10-08 11:45 NPT',
      ]),
    );
    // Each value sits right after its label.
    const after = (label: string) => runs[runs.indexOf(label) + 1];
    expect(after('Buyer:')).toBe('Aarav Shrestha');
    expect(after('Invoice No.:')).toBe('HP-2082-000142');
    expect(after('Bill No.:')).toBe('142');
    expect(after('Fiscal Year:')).toBe('2082/083');
    expect(after('Date (BS):')).toBe('2082-06-22');
  });

  it('prints the itemised table: quantity, rate, taxable amount and VAT of every line', async () => {
    const runs = await readable(invoice());

    const header = runs.indexOf('S.N.');
    expect(runs.slice(header, header + 9)).toEqual([
      'S.N.',
      'Particulars',
      'HS Code',
      'Qty',
      'Rate',
      'Discount',
      'Taxable',
      'VAT',
      'Amount',
    ]);
    expect(runs.slice(header + 9, header + 27)).toEqual([
      ...['1', 'Basmati Rice 5kg', '-', '1', '1,130.00', '0.00', '1,000.00', '130.00', '1,130.00'],
      ...['2', 'Delivery charge', '-', '1', '50.00', '0.00', '44.25', '5.75', '50.00'],
    ]);
  });

  it('prints the stored totals and the amount in words', async () => {
    const runs = await readable(invoice());
    const after = (label: string) => runs[runs.lastIndexOf(label) + 1];

    expect(after('Subtotal')).toBe('1,130.00');
    expect(after('Discount')).toBe('0.00');
    expect(after('Delivery charge')).toBe('50.00');
    expect(after('Taxable amount')).toBe('1,044.25');
    expect(after('VAT 13%')).toBe('135.75');
    expect(after('Non-taxable amount')).toBe('0.00');
    expect(after('Grand Total (NPR)')).toBe('1,180.00');
    expect(after('Amount in words:')).toBe('Rupees One Thousand One Hundred Eighty Only');
  });

  it('marks the first print ORIGINAL and a later one as its numbered copy, with the disclaimer', async () => {
    const original = await readable(invoice(), 0);
    const copy = await readable(invoice(), 3);

    expect(original[0]).toBe('ORIGINAL');
    expect(original).not.toContain('COPY OF ORIGINAL (3)');
    expect(copy[0]).toBe('COPY OF ORIGINAL (3)');
    expect(copy).not.toContain('ORIGINAL');
    expect(original.at(-1)).toBe(
      `${INVOICE_PLATFORM_DISCLAIMER}   HP-2082-000142 · ORIGINAL · Page 1 of 1`,
    );
    expect(copy.at(-1)).toContain('COPY OF ORIGINAL (3) · Page 1 of 1');
  });

  it('prints a seller that is not VAT registered as a PAN invoice', async () => {
    const runs = await readable(
      invoice({
        seller_is_vat_registered: false,
        taxable_amount_npr: 0,
        vat_rate_percent: 0,
        vat_amount_npr: 0,
        exempt_amount_npr: 1180,
        line_items: [line({ taxable_amount_npr: 0, vat_rate_percent: 0, vat_amount_npr: 0 })],
      }),
    );

    expect(runs).toContain('PAN: 302118845');
    expect(runs).toContain('INVOICE');
    expect(runs).not.toContain('TAX INVOICE');
    expect(runs[runs.indexOf('VAT 0%') + 1]).toBe('0.00');
    expect(runs[runs.indexOf('Non-taxable amount') + 1]).toBe('1,180.00');
  });

  it('labels a fleet delivery charge as the platform’s, and prints the HS code and payment method', async () => {
    const runs = await readable(
      invoice({
        delivery_charged_by: 'PLATFORM',
        payment_method: 'ESEWA',
        line_items: [line({ hs_code: '10063090' })],
      }),
    );

    expect(runs[runs.indexOf('Delivery charge (Hamro Pasal delivery)') + 1]).toBe('50.00');
    expect(runs).toContain('10063090');
    expect(runs).toContain('eSewa');
  });

  it('is the same bytes for the same invoice and copy, and different for another copy', async () => {
    const [first, again, copy] = await Promise.all([
      renderInvoicePdf(invoice(), 0),
      renderInvoicePdf(invoice(), 0),
      renderInvoicePdf(invoice(), 1),
    ]);

    expect(first.equals(again)).toBe(true);
    expect(first.equals(copy)).toBe(false);
  });

  it('continues a long invoice on further pages, each with the table header and the footer', async () => {
    const lines = Array.from({ length: 120 }, (_unused, index) =>
      line({ line_number: index + 1, product_name: `Item ${String(index + 1)}` }),
    );
    const pdf = await renderInvoicePdf(invoice({ line_items: lines }), 0, { compress: false });
    const runs = textRuns(pdf);

    const pages = pageCount(pdf);
    expect(pages).toBeGreaterThan(1);
    // Every page that carries lines repeats the header (the last may hold the totals alone).
    const headers = runs.filter((run) => run === 'Particulars').length;
    expect(headers).toBeGreaterThan(1);
    expect([pages - 1, pages]).toContain(headers);
    expect(runs.filter((run) => run.startsWith(INVOICE_PLATFORM_DISCLAIMER))).toHaveLength(pages);
    expect(runs.at(-1)).toContain(`Page ${String(pages)} of ${String(pages)}`);
    // Every line is printed once, and the totals after the last of them.
    for (const index of [1, 60, 120]) {
      expect(runs.filter((run) => run === `Item ${String(index)}`)).toHaveLength(1);
    }
    expect(runs.indexOf('Grand Total (NPR)')).toBeGreaterThan(runs.indexOf('Item 120'));
  });

  it('wraps a long product name inside its column instead of overprinting the next', async () => {
    const name =
      'Organic Himalayan Red Rice from Jumla, hand pounded, premium grade, 5 kilogram sack';
    const runs = await readable(invoice({ line_items: [line({ product_name: name })] }));

    const start = runs.findIndex((run) => run.startsWith('Organic Himalayan'));
    expect(start).toBeGreaterThan(-1);
    const pieces: string[] = [];
    for (let at = start; runs[at] !== '-'; at += 1) pieces.push(runs[at] ?? '');
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(' ').replace(/\s+/g, ' ').trim()).toBe(name);
  });

  it('shows a name the built-in fonts cannot draw as question marks, never as nothing', async () => {
    const runs = await readable(
      invoice({ buyer_name: 'सीता', line_items: [line({ product_name: 'चिया Tea' })] }),
    );

    expect(runs).toContain('????');
    expect(runs).toContain('???? Tea');
  });
});

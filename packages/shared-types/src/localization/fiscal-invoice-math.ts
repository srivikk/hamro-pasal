import { z } from 'zod';

/*
 * The arithmetic of SPEC core section 10 (Fiscal Invoicing) and Nepal section 5. It was written
 * and tested in the Vendor App (apps/mobile/src/features/vendor/invoice-math.ts) to render sample
 * invoices; it moved here unchanged (Phase 31) so the server that issues the real invoice and the
 * app use one implementation. Everything is computed in integer paisa.
 */

/** Standard VAT in Nepal. Catalogue prices are VAT inclusive. */
export const VAT_RATE_PERCENT = 13;

const toPaisa = (npr: number): number => Math.round(npr * 100);
const toNpr = (paisa: number): number => paisa / 100;

/** A VAT-inclusive amount split into its taxable part and 13% VAT, in paisa, half-up. */
export function splitVatPaisa(grossPaisa: number): { taxable: number; vat: number } {
  const taxable = Math.round((grossPaisa * 100) / (100 + VAT_RATE_PERCENT));
  return { taxable, vat: grossPaisa - taxable };
}

/**
 * Spreads a discount over the lines in proportion to their amounts (largest remainder), so the
 * parts are whole paisa and add up to the discount exactly.
 */
export function spreadDiscountPaisa(linePaisa: readonly number[], discountPaisa: number): number[] {
  const total = linePaisa.reduce((sum, value) => sum + value, 0);
  if (total === 0 || discountPaisa === 0) return linePaisa.map(() => 0);
  const exact = linePaisa.map((value) => (value * discountPaisa) / total);
  const shares = exact.map(Math.floor);
  let left = discountPaisa - shares.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (left === 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

const ONES = [
  'Zero',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

function belowHundred(value: number): string {
  if (value < 20) return ONES[value] ?? '';
  const tens = TENS[Math.floor(value / 10)] ?? '';
  return value % 10 === 0 ? tens : `${tens} ${ONES[value % 10] ?? ''}`;
}

/** A whole number in words with the Nepali grouping: thousand, lakh, crore. */
export function numberInWords(value: number): string {
  if (value === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(value / 10_000_000);
  const lakh = Math.floor((value % 10_000_000) / 100_000);
  const thousand = Math.floor((value % 100_000) / 1000);
  const hundred = Math.floor((value % 1000) / 100);
  const rest = value % 100;
  if (crore > 0) parts.push(`${numberInWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (hundred > 0) parts.push(`${ONES[hundred] ?? ''} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

/** "Rupees One Lakh Two Thousand Five Hundred and Paisa Fifty Only" (SPEC Nepal section 5). */
export function amountInWords(amountNpr: number): string {
  const paisa = toPaisa(amountNpr);
  const rupees = Math.floor(paisa / 100);
  const remainder = paisa % 100;
  const words = `Rupees ${numberInWords(rupees)}`;
  return remainder === 0 ? `${words} Only` : `${words} and Paisa ${belowHundred(remainder)} Only`;
}

export const invoiceDeliveryChargedBy = ['VENDOR', 'PLATFORM'] as const;
export type InvoiceDeliveryChargedBy = (typeof invoiceDeliveryChargedBy)[number];

/** One line of an invoice as issued: a copy, never a reference to the catalogue. */
export const invoiceLineSchema = z.strictObject({
  line_number: z.number().int().min(1),
  /** DELIVERY: the vendor's own delivery charge, taxed like goods. */
  line_type: z.enum(['ITEM', 'DELIVERY']),
  product_name: z.string().min(1),
  /** Required for imported goods, else null. */
  hs_code: z.string().nullable(),
  quantity: z.number().int().min(1),
  /** VAT inclusive, as charged. */
  unit_price_npr: z.number().min(0),
  line_discount_npr: z.number().min(0),
  taxable_amount_npr: z.number().min(0),
  vat_rate_percent: z.number().min(0),
  vat_amount_npr: z.number().min(0),
  line_total_npr: z.number().min(0),
});
export type InvoiceLine = z.infer<typeof invoiceLineSchema>;

/** A line as stored on the invoice row: the line, and the product it was (null for DELIVERY). */
export const invoiceLineItemSchema = invoiceLineSchema.extend({
  product_id: z.uuid().nullable(),
});
export type InvoiceLineItem = z.infer<typeof invoiceLineItemSchema>;

export interface InvoiceAmountsInput {
  readonly seller_is_vat_registered: boolean;
  readonly items: readonly {
    readonly product_name: string;
    readonly hs_code: string | null;
    readonly quantity: number;
    readonly unit_price_npr: number;
    /** An exempt product carries no VAT even from a VAT-registered seller. */
    readonly vat_exempt?: boolean;
  }[];
  /** Every discount on the order, the platform-funded share included (decided 2026-10-07). */
  readonly discount_npr: number;
  readonly delivery_charge_npr: number;
  readonly delivery_charged_by: InvoiceDeliveryChargedBy;
}

export interface InvoiceAmounts {
  /** The item lines in input order, then the DELIVERY line when the vendor charged the fee. */
  readonly lines: InvoiceLine[];
  readonly subtotal_npr: number;
  readonly taxable_amount_npr: number;
  readonly vat_rate_percent: number;
  readonly vat_amount_npr: number;
  readonly exempt_amount_npr: number;
  readonly grand_total_npr: number;
  readonly amount_in_words: string;
}

/**
 * The lines and totals of an invoice: the discount spread over the goods, each taxed line split
 * into taxable amount and VAT, the vendor's own delivery charge as a taxed line, and the totals.
 *
 * - The header's taxable and VAT amounts are the **sums of the lines**, so they add up to the
 *   grand total to the paisa (splitting the total once would differ from the lines by a paisa or
 *   two on some carts).
 * - The grand total is what the customer paid: goods - discount + delivery.
 * - A seller that is not VAT registered has no taxable amount and no VAT: everything is exempt.
 * - A delivery charge the platform collects (fleet delivery) is not the vendor's sale: it is in
 *   the grand total and outside taxable, VAT and exempt amounts.
 */
export function computeInvoiceAmounts(input: InvoiceAmountsInput): InvoiceAmounts {
  const vatRegistered = input.seller_is_vat_registered;
  const gross = input.items.map((item) => toPaisa(item.unit_price_npr) * item.quantity);
  const discounts = spreadDiscountPaisa(gross, toPaisa(input.discount_npr));

  let taxable = 0;
  let vat = 0;
  let exempt = 0;
  const lines: InvoiceLine[] = [];
  const addLine = (
    line: Pick<
      InvoiceLine,
      'line_type' | 'product_name' | 'hs_code' | 'quantity' | 'unit_price_npr'
    >,
    discountPaisa: number,
    netPaisa: number,
    taxed: boolean,
  ): void => {
    const split = taxed ? splitVatPaisa(netPaisa) : { taxable: 0, vat: 0 };
    taxable += split.taxable;
    vat += split.vat;
    if (!taxed) exempt += netPaisa;
    lines.push({
      ...line,
      line_number: lines.length + 1,
      line_discount_npr: toNpr(discountPaisa),
      taxable_amount_npr: toNpr(taxed ? split.taxable : netPaisa),
      vat_rate_percent: taxed ? VAT_RATE_PERCENT : 0,
      vat_amount_npr: toNpr(split.vat),
      line_total_npr: toNpr(netPaisa),
    });
  };

  input.items.forEach((item, index) => {
    const discount = discounts[index] ?? 0;
    addLine(
      {
        line_type: 'ITEM',
        product_name: item.product_name,
        hs_code: item.hs_code,
        quantity: item.quantity,
        unit_price_npr: item.unit_price_npr,
      },
      discount,
      (gross[index] ?? 0) - discount,
      vatRegistered && item.vat_exempt !== true,
    );
  });

  const deliveryPaisa = toPaisa(input.delivery_charge_npr);
  if (input.delivery_charged_by === 'VENDOR' && deliveryPaisa > 0) {
    addLine(
      {
        line_type: 'DELIVERY',
        product_name: 'Delivery charge',
        hs_code: null,
        quantity: 1,
        unit_price_npr: input.delivery_charge_npr,
      },
      0,
      deliveryPaisa,
      vatRegistered,
    );
  }

  const subtotal = gross.reduce((sum, value) => sum + value, 0);
  const grandTotal = subtotal - toPaisa(input.discount_npr) + deliveryPaisa;
  return {
    lines,
    subtotal_npr: toNpr(subtotal),
    taxable_amount_npr: toNpr(taxable),
    vat_rate_percent: vatRegistered ? VAT_RATE_PERCENT : 0,
    vat_amount_npr: toNpr(vat),
    exempt_amount_npr: toNpr(exempt),
    grand_total_npr: toNpr(grandTotal),
    amount_in_words: amountInWords(toNpr(grandTotal)),
  };
}

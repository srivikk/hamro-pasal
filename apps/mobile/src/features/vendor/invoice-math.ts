import { toNpr, toPaisa } from '../../lib/money';

/**
 * The arithmetic of SPEC core section 10 (Fiscal Invoicing), as the server will do it when it
 * issues invoices (STATE_HANDOFF.md §8Z.11). The app only uses it to build sample invoices; a real
 * invoice arrives computed and is never recalculated on the device.
 */

export const VAT_RATE_PERCENT = 13;
export const PLATFORM_DISCLAIMER = 'Generated via Hamro Pasal on behalf of the seller.';

export type PaymentMethod = 'COD' | 'ESEWA' | 'KHALTI';

export interface InvoiceLine {
  line_number: number;
  /** DELIVERY: the vendor's own delivery charge, taxed like goods. */
  line_type: 'ITEM' | 'DELIVERY';
  product_name: string;
  /** Required for imported goods, else null. */
  hs_code: string | null;
  quantity: number;
  /** VAT inclusive, as charged. */
  unit_price_npr: number;
  line_discount_npr: number;
  taxable_amount_npr: number;
  vat_rate_percent: number;
  vat_amount_npr: number;
  line_total_npr: number;
}

/** The invoice as the API will send it (the `invoices` row and its lines, §8Z.11). */
export interface VendorInvoice {
  id: string;
  document_type: 'INVOICE';
  order_id: string;
  fiscal_year: string;
  bill_number: number;
  /** AD, ISO 8601. */
  issued_at: string;
  /** BS, `YYYY-MM-DD`, stored at issue and never re-derived. */
  issued_date_bs: string;
  payment_method: PaymentMethod;
  seller_name: string;
  seller_address: string;
  seller_phone: string;
  seller_tax_id: string;
  seller_is_vat_registered: boolean;
  buyer_name: string;
  buyer_tax_id: string | null;
  platform_disclaimer: string;
  subtotal_npr: number;
  discount_npr: number;
  taxable_amount_npr: number;
  vat_rate_percent: number;
  vat_amount_npr: number;
  /** Sales carrying no VAT: exempt goods, or every line of a seller that is not VAT registered. */
  exempt_amount_npr: number;
  delivery_charge_npr: number;
  delivery_charged_by: 'VENDOR' | 'PLATFORM';
  grand_total_npr: number;
  amount_in_words: string;
  print_count: number;
  lines: InvoiceLine[];
}

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

/** "Rupees One Lakh Two Thousand Five Hundred and Paisa Fifty Only". */
export function amountInWords(amountNpr: number): string {
  const paisa = toPaisa(amountNpr);
  const rupees = Math.floor(paisa / 100);
  const remainder = paisa % 100;
  const words = `Rupees ${numberInWords(rupees)}`;
  return remainder === 0 ? `${words} Only` : `${words} and Paisa ${belowHundred(remainder)} Only`;
}

export interface InvoiceInput {
  id: string;
  order_id: string;
  fiscal_year: string;
  bill_number: number;
  issued_at: string;
  issued_date_bs: string;
  payment_method: PaymentMethod;
  seller: {
    name: string;
    address: string;
    phone: string;
    tax_id: string;
    is_vat_registered: boolean;
  };
  buyer: { name: string; tax_id: string | null };
  items: {
    product_name: string;
    hs_code: string | null;
    quantity: number;
    unit_price_npr: number;
    /** An exempt product carries no VAT even from a VAT-registered seller. */
    vat_exempt?: boolean;
  }[];
  /** Every discount on the order, the platform-funded share included (decided 2026-10-07). */
  discount_npr: number;
  delivery_charge_npr: number;
  delivery_charged_by: 'VENDOR' | 'PLATFORM';
}

/**
 * Builds the invoice: the discount spread over the goods, each taxable line split into taxable
 * amount and VAT, the vendor's own delivery charge as a taxed line, and the totals. The grand
 * total is what the customer paid: goods - discount + delivery.
 */
export function buildInvoice(input: InvoiceInput): VendorInvoice {
  const vatRegistered = input.seller.is_vat_registered;
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
  const vendorDelivers = input.delivery_charged_by === 'VENDOR';
  if (vendorDelivers && deliveryPaisa > 0) {
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
    id: input.id,
    document_type: 'INVOICE',
    order_id: input.order_id,
    fiscal_year: input.fiscal_year,
    bill_number: input.bill_number,
    issued_at: input.issued_at,
    issued_date_bs: input.issued_date_bs,
    payment_method: input.payment_method,
    seller_name: input.seller.name,
    seller_address: input.seller.address,
    seller_phone: input.seller.phone,
    seller_tax_id: input.seller.tax_id,
    seller_is_vat_registered: vatRegistered,
    buyer_name: input.buyer.name,
    buyer_tax_id: input.buyer.tax_id,
    platform_disclaimer: PLATFORM_DISCLAIMER,
    subtotal_npr: toNpr(subtotal),
    discount_npr: input.discount_npr,
    taxable_amount_npr: toNpr(taxable),
    vat_rate_percent: vatRegistered ? VAT_RATE_PERCENT : 0,
    vat_amount_npr: toNpr(vat),
    exempt_amount_npr: toNpr(exempt),
    delivery_charge_npr: input.delivery_charge_npr,
    delivery_charged_by: input.delivery_charged_by,
    grand_total_npr: toNpr(grandTotal),
    amount_in_words: amountInWords(toNpr(grandTotal)),
    print_count: 0,
    lines,
  };
}

/** `YYYY-MM-DD HH:mm` in Nepal Time (UTC+05:45, no daylight saving), whatever the device's zone. */
export function formatNepalDateTime(iso: string): string {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return iso;
  const nepal = new Date(instant + (5 * 60 + 45) * 60_000).toISOString();
  return `${nepal.slice(0, 10)} ${nepal.slice(11, 16)}`;
}

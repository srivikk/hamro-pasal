import {
  amountInWords,
  computeInvoiceAmounts,
  numberInWords,
  splitVatPaisa,
  spreadDiscountPaisa,
  VAT_RATE_PERCENT,
  type InvoiceLine,
} from '@hamro-pasal/shared-types';

/**
 * The arithmetic of SPEC core section 10 (Fiscal Invoicing) lives in @hamro-pasal/shared-types
 * since Phase 31 (it was written here): the server issues invoices with it. The app only uses it
 * to build sample invoices; a real invoice arrives computed and is never recalculated on the device.
 */
export { amountInWords, numberInWords, splitVatPaisa, spreadDiscountPaisa, VAT_RATE_PERCENT };
export type { InvoiceLine };

export const PLATFORM_DISCLAIMER = 'Generated via Hamro Pasal on behalf of the seller.';

export type PaymentMethod = 'COD' | 'ESEWA' | 'KHALTI';

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
  const amounts = computeInvoiceAmounts({
    seller_is_vat_registered: vatRegistered,
    items: input.items,
    discount_npr: input.discount_npr,
    delivery_charge_npr: input.delivery_charge_npr,
    delivery_charged_by: input.delivery_charged_by,
  });

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
    subtotal_npr: amounts.subtotal_npr,
    discount_npr: input.discount_npr,
    taxable_amount_npr: amounts.taxable_amount_npr,
    vat_rate_percent: amounts.vat_rate_percent,
    vat_amount_npr: amounts.vat_amount_npr,
    exempt_amount_npr: amounts.exempt_amount_npr,
    delivery_charge_npr: input.delivery_charge_npr,
    delivery_charged_by: input.delivery_charged_by,
    grand_total_npr: amounts.grand_total_npr,
    amount_in_words: amounts.amount_in_words,
    print_count: 0,
    lines: amounts.lines,
  };
}

/** `YYYY-MM-DD HH:mm` in Nepal Time (UTC+05:45, no daylight saving), whatever the device's zone. */
export function formatNepalDateTime(iso: string): string {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return iso;
  const nepal = new Date(instant + (5 * 60 + 45) * 60_000).toISOString();
  return `${nepal.slice(0, 10)} ${nepal.slice(11, 16)}`;
}

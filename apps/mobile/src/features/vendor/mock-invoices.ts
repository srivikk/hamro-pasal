import { buildInvoice, type InvoiceInput, type VendorInvoice } from './invoice-math';

/**
 * TEMPORARY: sample invoices for the Invoices screen, so the fiscal document can be laid out
 * before the server issues any (STATE_HANDOFF.md §8Z.11, unbuilt). Development builds only: a
 * production build lists none.
 *
 * The figures are computed by the rules the server will use. The dates are fixed sample values:
 * the AD and BS dates below were paired by hand (7 October 2025 is 21 Ashwin 2082, in fiscal year
 * 2082/083); nothing here converts between the calendars.
 */
export const INVOICE_MOCKS_ENABLED = __DEV__;

/** Shown in the header until the shop has saved its own PAN in Shop settings. */
export const SAMPLE_SELLER_TAX_ID = '301234567';

const sellerOf = (taxId: string): InvoiceInput['seller'] => ({
  name: 'Thamel Kirana Pasal',
  address: 'Thamel, Kathmandu Metropolitan City-26, Kathmandu',
  phone: '+9779800000011',
  tax_id: taxId,
  is_vat_registered: true,
});

const SAMPLES: readonly Omit<InvoiceInput, 'seller'>[] = [
  {
    id: 'sample-invoice-43',
    order_id: '7c1d2e3f-0000-4000-8000-0000004fa5b6',
    fiscal_year: '2082/083',
    bill_number: 43,
    issued_at: '2025-10-07T08:12:00.000Z',
    issued_date_bs: '2082-06-21',
    payment_method: 'ESEWA',
    buyer: { name: 'Sita Gurung', tax_id: null },
    items: [
      { product_name: 'Basmati Rice 5kg', hs_code: '10063000', quantity: 1, unit_price_npr: 1150 },
      { product_name: 'Masoor Dal 1kg', hs_code: null, quantity: 2, unit_price_npr: 220 },
    ],
    discount_npr: 100,
    delivery_charge_npr: 50,
    delivery_charged_by: 'VENDOR',
  },
  {
    id: 'sample-invoice-42',
    order_id: '6b0c1d2e-0000-4000-8000-0000009c2d17',
    fiscal_year: '2082/083',
    bill_number: 42,
    issued_at: '2025-10-06T11:40:00.000Z',
    issued_date_bs: '2082-06-20',
    payment_method: 'COD',
    buyer: { name: 'Aarav Shrestha', tax_id: null },
    items: [
      {
        product_name: 'Wai Wai Noodles (pack of 30)',
        hs_code: null,
        quantity: 2,
        unit_price_npr: 600,
      },
      { product_name: 'Ilam Tea 500g', hs_code: null, quantity: 1, unit_price_npr: 450 },
    ],
    discount_npr: 0,
    delivery_charge_npr: 50,
    delivery_charged_by: 'PLATFORM',
  },
  {
    id: 'sample-invoice-41',
    order_id: '5a9b0c1d-0000-4000-8000-000000e81f03',
    fiscal_year: '2082/083',
    bill_number: 41,
    issued_at: '2025-10-05T05:25:00.000Z',
    issued_date_bs: '2082-06-19',
    payment_method: 'KHALTI',
    buyer: { name: 'Pooja Maharjan', tax_id: '609876543' },
    items: [{ product_name: 'DDC Ghee 500ml', hs_code: null, quantity: 3, unit_price_npr: 750 }],
    discount_npr: 0,
    delivery_charge_npr: 0,
    delivery_charged_by: 'VENDOR',
  },
];

/** The shop's sample invoices, newest first. `taxId` is the PAN saved in Shop settings, if any. */
export function mockInvoices(taxId: string | null): VendorInvoice[] {
  if (!INVOICE_MOCKS_ENABLED) return [];
  const seller = sellerOf(taxId ?? SAMPLE_SELLER_TAX_ID);
  return SAMPLES.map((sample) => buildInvoice({ ...sample, seller }));
}

import { fireEvent, screen, within } from '@testing-library/react-native';

import VendorInvoicesScreen from '../../../app/(vendor)/invoices';
import { useAuthStore } from '../../store/useAuthStore';
import { useVendorShopStore } from '../../store/useVendorShopStore';
import { accessTokenFor } from '../../test/access-tokens';
import { renderWithProviders } from '../../test/render';
import {
  amountInWords,
  buildInvoice,
  formatNepalDateTime,
  numberInWords,
  splitVatPaisa,
  spreadDiscountPaisa,
  type InvoiceInput,
} from './invoice-math';
import { mockInvoices, SAMPLE_SELLER_TAX_ID } from './mock-invoices';

const VENDOR_USER_ID = '9f1c2a10-0000-4000-8000-0000000000aa';

const input = (overrides: Partial<InvoiceInput> = {}): InvoiceInput => ({
  id: 'inv-1',
  order_id: '7c1d2e3f-0000-4000-8000-0000004fa5b6',
  fiscal_year: '2082/083',
  bill_number: 7,
  issued_at: '2025-10-07T08:12:00.000Z',
  issued_date_bs: '2082-06-21',
  payment_method: 'ESEWA',
  seller: {
    name: 'Thamel Kirana Pasal',
    address: 'Thamel, Kathmandu',
    phone: '+9779800000011',
    tax_id: '301234567',
    is_vat_registered: true,
  },
  buyer: { name: 'Sita Gurung', tax_id: null },
  items: [{ product_name: 'Goods', hs_code: null, quantity: 1, unit_price_npr: 1130 }],
  discount_npr: 0,
  delivery_charge_npr: 0,
  delivery_charged_by: 'VENDOR',
  ...overrides,
});

const sum = (values: number[]): number => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

describe('invoice arithmetic (SPEC Fiscal Invoicing)', () => {
  it('splits a VAT-inclusive amount into taxable and 13% VAT, to the paisa', () => {
    expect(splitVatPaisa(113_000)).toEqual({ taxable: 100_000, vat: 13_000 });
    const odd = splitVatPaisa(10_000);
    expect(odd).toEqual({ taxable: 8850, vat: 1150 });
    expect(odd.taxable + odd.vat).toBe(10_000);
  });

  it('SPEC verification 12: 1130 of taxable goods is 1000.00 taxable and 130.00 VAT', () => {
    const invoice = buildInvoice(input());
    expect(invoice).toMatchObject({
      subtotal_npr: 1130,
      taxable_amount_npr: 1000,
      vat_amount_npr: 130,
      vat_rate_percent: 13,
      exempt_amount_npr: 0,
      grand_total_npr: 1130,
    });
  });

  it('spreads a discount over the lines in whole paisa that add up exactly', () => {
    expect(spreadDiscountPaisa([100_000, 50_000], 15_000)).toEqual([10_000, 5000]);
    const uneven = spreadDiscountPaisa([3333, 3333, 3334], 1000);
    expect(uneven.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(spreadDiscountPaisa([5000], 0)).toEqual([0]);
  });

  it('every discount lowers the taxable amount, and the grand total is what the customer paid', () => {
    // SPEC verification 5: goods 1000, discounts 100 + 90 (the platform share included), delivery 50.
    const invoice = buildInvoice(
      input({
        items: [{ product_name: 'Goods', hs_code: null, quantity: 1, unit_price_npr: 1000 }],
        discount_npr: 190,
        delivery_charge_npr: 50,
      }),
    );

    expect(invoice.grand_total_npr).toBe(860);
    expect(sum([invoice.taxable_amount_npr, invoice.vat_amount_npr])).toBe(860);
    expect(invoice.lines[0]).toMatchObject({ line_discount_npr: 190, line_total_npr: 810 });
    expect(sum(invoice.lines.map((line) => line.line_total_npr))).toBe(860);
  });

  it("taxes the shop's own delivery charge as a line, and keeps a fleet charge out of its sales", () => {
    const own = buildInvoice(input({ delivery_charge_npr: 113 }));
    expect(own.lines.at(-1)).toMatchObject({
      line_type: 'DELIVERY',
      taxable_amount_npr: 100,
      vat_amount_npr: 13,
    });
    expect(own.grand_total_npr).toBe(1243);

    const fleet = buildInvoice(input({ delivery_charge_npr: 50, delivery_charged_by: 'PLATFORM' }));
    expect(fleet.lines).toHaveLength(1);
    expect(fleet).toMatchObject({ taxable_amount_npr: 1000, vat_amount_npr: 130 });
    expect(fleet.grand_total_npr).toBe(1180);
    expect(sum([fleet.taxable_amount_npr, fleet.vat_amount_npr, fleet.delivery_charge_npr])).toBe(
      1180,
    );
  });

  it('shows no VAT for a seller that is not VAT registered, or for an exempt product', () => {
    const pan = buildInvoice(input({ seller: { ...input().seller, is_vat_registered: false } }));
    expect(pan).toMatchObject({
      taxable_amount_npr: 0,
      vat_amount_npr: 0,
      vat_rate_percent: 0,
      exempt_amount_npr: 1130,
      grand_total_npr: 1130,
    });

    const mixed = buildInvoice(
      input({
        items: [
          { product_name: 'Taxed', hs_code: null, quantity: 1, unit_price_npr: 113 },
          {
            product_name: 'Exempt',
            hs_code: null,
            quantity: 2,
            unit_price_npr: 60,
            vat_exempt: true,
          },
        ],
      }),
    );
    expect(mixed).toMatchObject({
      taxable_amount_npr: 100,
      vat_amount_npr: 13,
      exempt_amount_npr: 120,
      grand_total_npr: 233,
    });
  });

  it('writes amounts in words with the Nepali grouping', () => {
    expect(numberInWords(0)).toBe('Zero');
    expect(numberInWords(19)).toBe('Nineteen');
    expect(numberInWords(860)).toBe('Eight Hundred Sixty');
    expect(numberInWords(12_345_678)).toBe(
      'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight',
    );
    expect(amountInWords(860)).toBe('Rupees Eight Hundred Sixty Only');
    expect(amountInWords(102_500.5)).toBe(
      'Rupees One Lakh Two Thousand Five Hundred and Paisa Fifty Only',
    );
    expect(amountInWords(0.05)).toBe('Rupees Zero and Paisa Five Only');
  });

  it('shows the issue time in Nepal Time, whatever the device zone', () => {
    expect(formatNepalDateTime('2025-10-07T08:12:00.000Z')).toBe('2025-10-07 13:57');
    expect(formatNepalDateTime('2025-10-07T19:00:00.000Z')).toBe('2025-10-08 00:45');
  });
});

describe('sample invoices', () => {
  it('are in fiscal year 2082/083 with consecutive bill numbers, newest first', () => {
    const invoices = mockInvoices(null);
    expect(invoices.map((invoice) => invoice.bill_number)).toEqual([43, 42, 41]);
    expect(new Set(invoices.map((invoice) => invoice.fiscal_year))).toEqual(new Set(['2082/083']));
    expect(invoices.every((invoice) => invoice.seller_tax_id === SAMPLE_SELLER_TAX_ID)).toBe(true);
  });

  it('each add up: goods - discount + delivery, and taxable + VAT (+ a fleet charge)', () => {
    for (const invoice of mockInvoices(null)) {
      expect(invoice.grand_total_npr).toBe(
        sum([invoice.subtotal_npr, -invoice.discount_npr, invoice.delivery_charge_npr]),
      );
      const platformDelivery =
        invoice.delivery_charged_by === 'PLATFORM' ? invoice.delivery_charge_npr : 0;
      expect(
        sum([
          invoice.taxable_amount_npr,
          invoice.vat_amount_npr,
          invoice.exempt_amount_npr,
          platformDelivery,
        ]),
      ).toBe(invoice.grand_total_npr);
    }
  });
});

describe('Invoices screen', () => {
  beforeEach(() => {
    useAuthStore.getState().setLocale('en');
    useAuthStore.getState().setSession({
      accessToken: accessTokenFor('VENDOR', VENDOR_USER_ID),
      refreshToken: 'r.jwt',
    });
    useVendorShopStore.setState({ online: true, stored: null });
  });

  it('lists the delivered orders that were invoiced, each with View Invoice', () => {
    renderWithProviders(<VendorInvoicesScreen />);

    const row = within(screen.getByTestId('invoice-row-sample-invoice-43'));
    expect(row.getByText('Bill 000043 · FY 2082/083')).toBeOnTheScreen();
    expect(row.getByText('Order #4FA5B6 · 2082-06-21 BS · Sita Gurung')).toBeOnTheScreen();
    expect(row.getByText('View Invoice')).toBeOnTheScreen();
    expect(screen.getByTestId('view-invoice-sample-invoice-42')).toBeOnTheScreen();
    expect(screen.getByTestId('view-invoice-sample-invoice-41')).toBeOnTheScreen();
    expect(screen.queryByTestId('invoice-title')).not.toBeOnTheScreen();
  });

  it('opens the invoice as a fiscal document: header, metadata, VAT lines, totals, disclaimer', () => {
    renderWithProviders(<VendorInvoicesScreen />);

    fireEvent.press(screen.getByTestId('view-invoice-sample-invoice-43'));

    expect(screen.getByTestId('invoice-seller-name')).toHaveTextContent('Thamel Kirana Pasal');
    expect(screen.getByTestId('invoice-seller-tax-id')).toHaveTextContent('VAT No: 301234567');
    expect(screen.getByTestId('invoice-title')).toHaveTextContent('Tax Invoice');
    expect(screen.getByText('Fiscal Year (आर्थिक वर्ष)')).toBeOnTheScreen();
    expect(screen.getByTestId('invoice-fiscal-year')).toHaveTextContent('2082/083');
    expect(screen.getByText('Bill No. (बिजक नम्बर)')).toBeOnTheScreen();
    expect(screen.getByTestId('invoice-bill-number')).toHaveTextContent('000043');
    expect(screen.getByTestId('invoice-date-bs')).toHaveTextContent('2082-06-21');
    expect(screen.getByTestId('invoice-date-ad')).toHaveTextContent('2025-10-07 13:57');
    expect(screen.getByTestId('invoice-payment')).toHaveTextContent('eSewa');
    expect(screen.getByTestId('invoice-buyer')).toHaveTextContent('Sita Gurung');

    // Goods 1150 + 2 × 220 = 1590, discount 100, own delivery 50: the customer paid 1540.
    const rice = within(screen.getByTestId('invoice-line-1'));
    expect(rice.getByText('Basmati Rice 5kg')).toBeOnTheScreen();
    expect(rice.getByText('HS Code: 10063000')).toBeOnTheScreen();
    expect(rice.getByText('1 × 1150.00')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('invoice-line-3')).getByText('Delivery charge'),
    ).toBeOnTheScreen();
    expect(screen.getByText('VAT 13%')).toBeOnTheScreen();
    expect(screen.getByTestId('invoice-subtotal')).toHaveTextContent('1590.00');
    expect(screen.getByTestId('invoice-discount')).toHaveTextContent('- 100.00');
    expect(screen.getByTestId('invoice-taxable')).toHaveTextContent('1362.83');
    expect(screen.getByTestId('invoice-vat')).toHaveTextContent('177.17');
    expect(screen.getByTestId('invoice-delivery')).toHaveTextContent('50.00');
    expect(screen.getByTestId('invoice-grand-total')).toHaveTextContent('1540.00');
    expect(screen.getByTestId('invoice-in-words')).toHaveTextContent(
      'In words: Rupees One Thousand Five Hundred Forty Only',
    );
    expect(screen.getByTestId('invoice-disclaimer')).toHaveTextContent(
      'Generated via Hamro Pasal on behalf of the seller.',
    );
  });

  it('is monochrome: the document uses black on white only', () => {
    renderWithProviders(<VendorInvoicesScreen />);
    fireEvent.press(screen.getByTestId('view-invoice-sample-invoice-43'));

    const classes = screen
      .getByTestId('invoice-sample-invoice-43')
      .findAll((node) => typeof node.props.className === 'string')
      .map((node) => String(node.props.className))
      .join(' ');

    expect(classes).not.toMatch(/(red|green|emerald|amber|blue|brand|violet)-|bg-gray/);
    expect(classes).toContain('text-black');
  });

  it("names a fleet delivery charge as Hamro Pasal's, and shows a buyer's PAN when there is one", () => {
    renderWithProviders(<VendorInvoicesScreen />);

    fireEvent.press(screen.getByTestId('view-invoice-sample-invoice-42'));
    expect(screen.getByText('Delivery charge (Hamro Pasal delivery)')).toBeOnTheScreen();
    expect(screen.queryByTestId('invoice-discount')).not.toBeOnTheScreen();
    expect(screen.queryByTestId('invoice-buyer-tax-id')).not.toBeOnTheScreen();
    fireEvent.press(screen.getByTestId('invoice-close'));
    expect(screen.queryByTestId('invoice-title')).not.toBeOnTheScreen();

    fireEvent.press(screen.getByTestId('view-invoice-sample-invoice-41'));
    expect(screen.getByTestId('invoice-buyer-tax-id')).toHaveTextContent('609876543');
  });

  it("prints the shop's own PAN once it is saved in Shop settings", () => {
    useVendorShopStore.getState().saveSettings(
      {
        taxId: '612345678',
        fulfillmentMode: 'SELF_DELIVERY',
        deliveryScope: 'NATION_WIDE',
        radiusKm: null,
        serviceablePalikas: [],
        baseDeliveryFeeNpr: 0,
        perKmFeeNpr: 0,
        freeDeliveryAboveNpr: null,
      },
      VENDOR_USER_ID,
    );
    renderWithProviders(<VendorInvoicesScreen />);

    fireEvent.press(screen.getByTestId('view-invoice-sample-invoice-43'));

    expect(screen.getByTestId('invoice-seller-tax-id')).toHaveTextContent('VAT No: 612345678');
  });
});

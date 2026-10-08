import {
  amountInWords,
  computeInvoiceAmounts,
  invoiceLineItemSchema,
  numberInWords,
  splitVatPaisa,
  spreadDiscountPaisa,
} from './fiscal-invoice-math';

const paisa = (npr: number) => Math.round(npr * 100);

describe('amountInWords (SPEC Nepal section 5)', () => {
  it('writes rupees and paisa with the Nepali grouping', () => {
    expect(amountInWords(102_500.5)).toBe(
      'Rupees One Lakh Two Thousand Five Hundred and Paisa Fifty Only',
    );
    expect(amountInWords(1550.5)).toBe(
      'Rupees One Thousand Five Hundred Fifty and Paisa Fifty Only',
    );
    expect(amountInWords(860)).toBe('Rupees Eight Hundred Sixty Only');
    expect(amountInWords(12_345_678.09)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Paisa Nine Only',
    );
  });

  it('handles zero, paisa only, teens and round numbers', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(0.05)).toBe('Rupees Zero and Paisa Five Only');
    expect(amountInWords(13.19)).toBe('Rupees Thirteen and Paisa Nineteen Only');
    expect(amountInWords(100_000)).toBe('Rupees One Lakh Only');
    expect(amountInWords(10_000_000)).toBe('Rupees One Crore Only');
    expect(numberInWords(1_000_000_000)).toBe('One Hundred Crore');
  });

  it('is not thrown off by floating point: 1.15 is one rupee fifteen paisa, 0.07 x 3 is 21', () => {
    expect(amountInWords(1.15)).toBe('Rupees One and Paisa Fifteen Only');
    expect(amountInWords(0.07 * 3)).toBe('Rupees Zero and Paisa Twenty One Only');
    expect(amountInWords(1130.0000000001)).toBe('Rupees One Thousand One Hundred Thirty Only');
  });
});

describe('the VAT split of a VAT-inclusive amount', () => {
  it('is exact for SPEC verification 12: 1130.00 is 1000.00 + 130.00', () => {
    expect(splitVatPaisa(113_000)).toEqual({ taxable: 100_000, vat: 13_000 });
  });

  it('rounds the taxable part half-up and gives VAT the remainder, so the two always add up', () => {
    expect(splitVatPaisa(5000)).toEqual({ taxable: 4425, vat: 575 });
    expect(splitVatPaisa(1)).toEqual({ taxable: 1, vat: 0 });
    expect(splitVatPaisa(0)).toEqual({ taxable: 0, vat: 0 });
    for (let gross = 0; gross <= 5000; gross += 1) {
      const { taxable, vat } = splitVatPaisa(gross);
      expect(taxable + vat).toBe(gross);
      expect(vat).toBeGreaterThanOrEqual(0);
      // Never more than a paisa from 13% of the taxable amount.
      expect(Math.abs(vat - taxable * 0.13)).toBeLessThanOrEqual(1);
    }
  });
});

describe('spreading a discount over lines', () => {
  it('gives whole paisa that add up to the discount, the largest remainders first', () => {
    expect(spreadDiscountPaisa([3333, 3333, 3334], 1000)).toEqual([333, 333, 334]);
    expect(spreadDiscountPaisa([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(spreadDiscountPaisa([5000], 190)).toEqual([190]);
    expect(spreadDiscountPaisa([0, 0], 0)).toEqual([0, 0]);
    for (const discount of [1, 7, 999, 10_021]) {
      const shares = spreadDiscountPaisa([3333, 3333, 3334, 21], discount);
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(discount);
    }
  });
});

describe('computeInvoiceAmounts', () => {
  const base = {
    seller_is_vat_registered: true,
    items: [{ product_name: 'Rice', hs_code: null, quantity: 2, unit_price_npr: 565 }],
    discount_npr: 0,
    delivery_charge_npr: 50,
    delivery_charged_by: 'VENDOR' as const,
  };

  it('makes the header the sum of the lines, and the grand total what was paid', () => {
    const amounts = computeInvoiceAmounts(base);
    expect(amounts).toMatchObject({
      subtotal_npr: 1130,
      taxable_amount_npr: 1044.25,
      vat_rate_percent: 13,
      vat_amount_npr: 135.75,
      exempt_amount_npr: 0,
      grand_total_npr: 1180,
      amount_in_words: 'Rupees One Thousand One Hundred Eighty Only',
    });
    expect(amounts.lines.map((line) => line.line_type)).toEqual(['ITEM', 'DELIVERY']);
    for (const line of amounts.lines) {
      expect(invoiceLineItemSchema.safeParse({ ...line, product_id: null }).success).toBe(true);
    }
  });

  it('has no taxable amount and no VAT for a seller that is not VAT registered', () => {
    expect(computeInvoiceAmounts({ ...base, seller_is_vat_registered: false })).toMatchObject({
      taxable_amount_npr: 0,
      vat_rate_percent: 0,
      vat_amount_npr: 0,
      exempt_amount_npr: 1180,
      grand_total_npr: 1180,
    });
  });

  it('keeps a platform delivery charge in the total and out of the seller’s sales', () => {
    const amounts = computeInvoiceAmounts({ ...base, delivery_charged_by: 'PLATFORM' });
    expect(amounts).toMatchObject({ taxable_amount_npr: 1000, vat_amount_npr: 130 });
    expect(amounts.grand_total_npr).toBe(1180);
    expect(amounts.lines).toHaveLength(1);
  });

  it('never loses a paisa: taxable + VAT + exempt (+ platform delivery) is the total, for many carts', () => {
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    for (let round = 0; round < 300; round += 1) {
      const items = Array.from({ length: 1 + next(5) }, (_, index) => ({
        product_name: `P${String(index)}`,
        hs_code: null,
        quantity: 1 + next(4),
        unit_price_npr: (1 + next(99_999)) / 100,
      }));
      const subtotal = items.reduce((sum, i) => sum + paisa(i.unit_price_npr) * i.quantity, 0);
      const discount = next(subtotal + 1);
      const delivery = next(10_000);
      const byPlatform = next(2) === 0;
      const amounts = computeInvoiceAmounts({
        seller_is_vat_registered: next(4) !== 0,
        items,
        discount_npr: discount / 100,
        delivery_charge_npr: delivery / 100,
        delivery_charged_by: byPlatform ? 'PLATFORM' : 'VENDOR',
      });
      const paid = subtotal - discount + delivery;
      expect(paisa(amounts.grand_total_npr)).toBe(paid);
      expect(
        paisa(amounts.taxable_amount_npr) +
          paisa(amounts.vat_amount_npr) +
          paisa(amounts.exempt_amount_npr) +
          (byPlatform ? delivery : 0),
      ).toBe(paid);
      expect(amounts.lines.reduce((sum, l) => sum + paisa(l.line_discount_npr), 0)).toBe(discount);
    }
  });
});

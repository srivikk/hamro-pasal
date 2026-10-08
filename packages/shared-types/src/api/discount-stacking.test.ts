import { checkoutRequestSchema } from './requests';
import {
  cartQuoteResponseSchema,
  orderViewSchema,
  paymentMethodUnavailableDetailsSchema,
  quoteChangedDetailsSchema,
} from './responses';

const OFFER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c51';
const CAMPAIGN_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c52';

const address = {
  province_id: 3,
  district_string: 'Kathmandu',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  ward_number: 26,
  tole_locality: 'Thamel',
  landmark: 'Near Kathmandu Guest House',
  exact_lat: 27.7154,
  exact_lng: 85.3123,
};
const checkout = {
  idempotency_key: 'checkout-0001',
  vendor_id: OFFER_ID,
  payment_method: 'COD',
  items: [{ product_id: CAMPAIGN_ID, quantity: 2 }],
  delivery_address: address,
};
const order = {
  id: OFFER_ID,
  vendor_id: CAMPAIGN_ID,
  state: 'PLACED',
  payment_method: 'COD',
  payment_status: 'PENDING',
  fulfillment: 'SELF_DELIVERY',
  subtotal_npr: 1000,
  delivery_fee_npr: 50,
  total_npr: 860,
  created_at: '2026-10-08T06:00:00.000Z',
};

describe('the quote with a vendor offer and a platform promo (SPEC verification 5)', () => {
  const quote = {
    subtotal_npr: 1000,
    vendor_offer: { id: OFFER_ID, label: 'Flat Rs. 100 OFF', discount_npr: 100 },
    platform_promo: { id: CAMPAIGN_ID, label: 'Dashain 10%', discount_npr: 90 },
    delivery_fee_npr: 50,
    distance_km: 1.2,
    total_npr: 860,
    payment_options: [{ method: 'COD', available: true }],
  };

  it('carries both discounts as separate lines', () => {
    const parsed = cartQuoteResponseSchema.parse(quote);
    expect(parsed.vendor_offer?.discount_npr).toBe(100);
    expect(parsed.platform_promo?.discount_npr).toBe(90);
    expect(parsed.total_npr).toBe(860);
  });

  it('never carries a discount of nothing, or one without its label and source', () => {
    for (const broken of [
      { ...quote.vendor_offer, discount_npr: 0 },
      { ...quote.vendor_offer, label: '' },
      { label: 'Flat Rs. 100 OFF', discount_npr: 100 },
      { ...quote.vendor_offer, vendor_share_npr: 45 },
    ]) {
      expect(cartQuoteResponseSchema.safeParse({ ...quote, vendor_offer: broken }).success).toBe(
        false,
      );
    }
  });
});

describe('checkout: the total the customer was quoted', () => {
  it('is optional: a client that sends none is priced as before', () => {
    expect(checkoutRequestSchema.parse(checkout).expected_total_npr).toBeUndefined();
  });

  it('is an amount of 0 or more, compared by the server and never a price', () => {
    expect(
      checkoutRequestSchema.parse({ ...checkout, expected_total_npr: 860 }).expected_total_npr,
    ).toBe(860);
    for (const value of [-1, '860', null]) {
      expect(
        checkoutRequestSchema.safeParse({ ...checkout, expected_total_npr: value }).success,
      ).toBe(false);
    }
  });

  it('still refuses any other amount from the client', () => {
    for (const key of ['total_npr', 'discount_npr', 'vendor_offer_id', 'subtotal_npr']) {
      expect(checkoutRequestSchema.safeParse({ ...checkout, [key]: 1 }).success).toBe(false);
    }
  });
});

describe('the order view’s discounts', () => {
  it('carries the vendor offer and the campaign discount apart', () => {
    expect(
      orderViewSchema.parse({
        ...order,
        vendor_offer_discount_npr: 100,
        platform_promo_discount_npr: 90,
      }),
    ).toMatchObject({ vendor_offer_discount_npr: 100, platform_promo_discount_npr: 90 });
  });

  it('reads an API from before the fields as "no discount"', () => {
    expect(orderViewSchema.parse(order)).toMatchObject({
      vendor_offer_discount_npr: 0,
      platform_promo_discount_npr: 0,
    });
  });

  it('refuses a negative discount, and still nothing it does not know', () => {
    expect(orderViewSchema.safeParse({ ...order, vendor_offer_discount_npr: -1 }).success).toBe(
      false,
    );
    expect(orderViewSchema.safeParse({ ...order, platform_commission_amount: 85.5 }).success).toBe(
      false,
    );
  });
});

describe('details of the two checkout refusals the app answers with a dialog', () => {
  it('409 QUOTE_CHANGED: the cart as the server prices it now', () => {
    const details = {
      quote: {
        subtotal_npr: 1000,
        vendor_offer: null,
        platform_promo: null,
        delivery_fee_npr: 50,
        total_npr: 1050,
      },
    };
    expect(quoteChangedDetailsSchema.parse(details).quote.total_npr).toBe(1050);
    // Without the quote (the offer ended between pricing and the order) there is nothing to read.
    expect(quoteChangedDetailsSchema.safeParse(undefined).success).toBe(false);
    expect(quoteChangedDetailsSchema.safeParse({}).success).toBe(false);
  });

  it('422 PAYMENT_METHOD_UNAVAILABLE: what the shop accepts and why, extra keys tolerated', () => {
    const parsed = paymentMethodUnavailableDetailsSchema.parse({
      accepted: ['COD'],
      reason: 'SETTLEMENT_MODEL',
      settlement_model: 'COD_CREDIT',
    });
    expect(parsed).toMatchObject({ accepted: ['COD'], reason: 'SETTLEMENT_MODEL' });
    expect(
      paymentMethodUnavailableDetailsSchema.safeParse({ accepted: ['CARD'], reason: 'X' }).success,
    ).toBe(false);
  });
});

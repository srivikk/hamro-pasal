import { randomUUID } from 'node:crypto';

import { NEPAL_BOUNDING_BOX } from '../nepal/geo';
import {
  checkoutRequestSchema,
  driverDeliverRequestSchema,
  idParamSchema,
  otpSendRequestSchema,
  otpVerifyRequestSchema,
  reviewSubmitRequestSchema,
  vendorReviewSubmitRequestSchema,
  tokenRefreshRequestSchema,
  vendorFeedQuerySchema,
} from './requests';

const address = {
  province_id: 3,
  district_string: 'kathmandu',
  municipality_palika_string: 'Kathmandu Metropolitan City',
  ward_number: 26,
  tole_locality: 'Thamel',
  landmark: 'Near Kathmandu Guest House',
  exact_lat: 27.7149,
  exact_lng: 85.3106,
};

const cart = {
  idempotency_key: randomUUID(),
  vendor_id: randomUUID(),
  payment_method: 'COD',
  items: [{ product_id: randomUUID(), quantity: 2 }],
};

describe('checkoutRequestSchema', () => {
  it('requires a delivery address', () => {
    const result = checkoutRequestSchema.safeParse(cart);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['delivery_address']);
    expect(checkoutRequestSchema.safeParse({ ...cart, delivery_address: null }).success).toBe(
      false,
    );
  });

  it('validates and normalises the Nepal delivery address', () => {
    const parsed = checkoutRequestSchema.parse({ ...cart, delivery_address: address });

    expect(parsed.delivery_address).toEqual({ ...address, district_string: 'Kathmandu' });
  });

  it('rejects Western-style or incomplete addresses', () => {
    const issues = (deliveryAddress: unknown) => {
      const result = checkoutRequestSchema.safeParse({
        ...cart,
        delivery_address: deliveryAddress,
      });
      return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
    };

    expect(issues({ ...address, zip_code: '10001' })).toEqual(['delivery_address']);
    expect(issues({ ...address, ward_number: 0 })).toEqual(['delivery_address.ward_number']);
    expect(issues({ ...address, province_id: 1 })).toEqual(['delivery_address.district_string']);
    expect(issues({ ...address, exact_lat: 51.5, exact_lng: -0.12 })).toEqual([
      'delivery_address.exact_lat',
      'delivery_address.exact_lng',
    ]);
  });
});

describe('vendorFeedQuerySchema', () => {
  it('parses query-string coordinates and the optional Palika', () => {
    expect(
      vendorFeedQuerySchema.parse({
        lat: '27.7149',
        lng: '85.3106',
        municipality_palika_string: ' Kathmandu Metropolitan City ',
      }),
    ).toEqual({
      lat: 27.7149,
      lng: 85.3106,
      municipality_palika_string: 'Kathmandu Metropolitan City',
    });
    expect(vendorFeedQuerySchema.parse({ lat: '27.7', lng: '85.3' })).toEqual({
      lat: 27.7,
      lng: 85.3,
    });
  });

  it('rejects missing, non-numeric, repeated and out-of-Nepal coordinates', () => {
    const fails = (query: Record<string, unknown>) =>
      !vendorFeedQuerySchema.safeParse(query).success;

    expect(fails({ lng: '85.3' })).toBe(true);
    expect(fails({ lat: '', lng: '85.3' })).toBe(true);
    expect(fails({ lat: 'north', lng: '85.3' })).toBe(true);
    expect(fails({ lat: ['27.7', '27.8'], lng: '85.3' })).toBe(true);
    expect(fails({ lat: String(NEPAL_BOUNDING_BOX.maxLat + 0.01), lng: '85.3' })).toBe(true);
    expect(fails({ lat: '51.5', lng: '-0.12' })).toBe(true);
    expect(fails({ lat: '27.7', lng: '85.3', radius: '50' })).toBe(true);
  });
});

describe('idParamSchema', () => {
  it('requires a uuid', () => {
    expect(idParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(idParamSchema.safeParse({ id: randomUUID() }).success).toBe(true);
  });
});

describe('OTP request schemas', () => {
  it('accept only strict +977 numbers', () => {
    expect(otpSendRequestSchema.safeParse({ phone: '+9779800000001' }).success).toBe(true);
    for (const phone of ['9800000001', '977 9800000001', '+91 9800000001', '+9771234567890', '']) {
      expect(otpSendRequestSchema.safeParse({ phone }).success).toBe(false);
    }
  });

  it('require a 6-digit code', () => {
    const verify = (code: string) =>
      otpVerifyRequestSchema.safeParse({ phone: '+9779800000001', code }).success;

    expect(verify('042187')).toBe(true);
    expect(verify('42187')).toBe(false);
    expect(verify('0421870')).toBe(false);
    expect(verify('०४२१८७')).toBe(false);
    expect(verify('04 218')).toBe(false);
  });
});

describe('tokenRefreshRequestSchema', () => {
  it('requires a non-empty refresh token and nothing else', () => {
    expect(tokenRefreshRequestSchema.safeParse({ refresh_token: 'a.b.c' }).success).toBe(true);
    expect(tokenRefreshRequestSchema.safeParse({ refresh_token: '' }).success).toBe(false);
    expect(tokenRefreshRequestSchema.safeParse({}).success).toBe(false);
    expect(
      tokenRefreshRequestSchema.safeParse({ refresh_token: 'a.b.c', user_id: 'x' }).success,
    ).toBe(false);
  });
});

describe('reviewSubmitRequestSchema', () => {
  const orderId = randomUUID();

  it('accepts a 1-5 integer rating with optional feedback', () => {
    expect(reviewSubmitRequestSchema.parse({ order_id: orderId, rating: 5 })).toEqual({
      order_id: orderId,
      rating: 5,
      feedback: null,
    });
    expect(
      reviewSubmitRequestSchema.parse({ order_id: orderId, rating: 1, feedback: '  Late.  ' })
        .feedback,
    ).toBe('Late.');
  });

  it('stores blank feedback as null', () => {
    expect(
      reviewSubmitRequestSchema.parse({ order_id: orderId, rating: 3, feedback: '   ' }).feedback,
    ).toBeNull();
  });

  it.each([0, 6, 2.5, '5'])('rejects rating %p', (rating) => {
    expect(reviewSubmitRequestSchema.safeParse({ order_id: orderId, rating }).success).toBe(false);
  });

  it('rejects feedback over 500 characters and unknown fields', () => {
    expect(
      reviewSubmitRequestSchema.safeParse({
        order_id: orderId,
        rating: 4,
        feedback: 'a'.repeat(501),
      }).success,
    ).toBe(false);
    expect(
      reviewSubmitRequestSchema.safeParse({ order_id: orderId, rating: 4, is_published: true })
        .success,
    ).toBe(false);
  });
});

describe('vendorReviewSubmitRequestSchema', () => {
  it('takes the rating and feedback only (the order comes from the path)', () => {
    expect(vendorReviewSubmitRequestSchema.parse({ rating: 2, feedback: '  Not home.  ' })).toEqual(
      {
        rating: 2,
        feedback: 'Not home.',
      },
    );
    expect(
      vendorReviewSubmitRequestSchema.safeParse({ rating: 2, order_id: randomUUID() }).success,
    ).toBe(false);
    expect(vendorReviewSubmitRequestSchema.safeParse({ rating: 0 }).success).toBe(false);
  });
});

describe('driverDeliverRequestSchema', () => {
  it('accepts exactly four ASCII digits, leading zeros kept', () => {
    expect(driverDeliverRequestSchema.parse({ delivery_otp: '0042' })).toEqual({
      delivery_otp: '0042',
    });
  });

  it('refuses other lengths, non-digits, Devanagari digits, numbers and extra fields', () => {
    const parse = (body: unknown) => driverDeliverRequestSchema.safeParse(body).success;

    expect(parse({ delivery_otp: '123' })).toBe(false);
    expect(parse({ delivery_otp: '12345' })).toBe(false);
    expect(parse({ delivery_otp: '12a4' })).toBe(false);
    expect(parse({ delivery_otp: '१२३४' })).toBe(false);
    expect(parse({ delivery_otp: 1234 })).toBe(false);
    expect(parse({})).toBe(false);
    expect(parse({ delivery_otp: '1234', driver_id: randomUUID() })).toBe(false);
  });
});

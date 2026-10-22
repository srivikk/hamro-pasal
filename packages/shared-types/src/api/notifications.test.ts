import {
  deviceTokenRegisterRequestSchema,
  deviceTokenRegisterResponseSchema,
  expoPushTokenSchema,
  LEGACY_ORDER_ALARM_CHANNEL_IDS,
  ORDER_ALARM_CHANNEL_ID,
  ORDER_ALARM_SOUND,
  ORDER_ALARM_SOUND_RESOURCE,
  orderPushDataSchema,
} from './notifications';

describe('expoPushTokenSchema', () => {
  it.each(['ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', 'ExpoPushToken[abc-DEF_123]'])(
    'accepts %s',
    (token) => {
      expect(expoPushTokenSchema.parse(token)).toBe(token);
    },
  );

  it.each([
    '',
    'ExponentPushToken[]',
    'ExponentPushToken[abc',
    'PushToken[abc]',
    ' ExponentPushToken[abc]',
    'fcm:APA91bHun4MxP5egoKMwt2KZFBaFUH',
    `ExponentPushToken[${'x'.repeat(260)}]`,
  ])('refuses %j', (token) => {
    expect(expoPushTokenSchema.safeParse(token).success).toBe(false);
  });
});

describe('deviceTokenRegisterRequestSchema', () => {
  const valid = { token: 'ExponentPushToken[abc]', platform: 'ANDROID' };

  it('accepts a token with its platform', () => {
    expect(deviceTokenRegisterRequestSchema.parse(valid)).toEqual(valid);
    expect(deviceTokenRegisterRequestSchema.safeParse({ ...valid, platform: 'IOS' }).success).toBe(
      true,
    );
  });

  it('refuses an unknown platform, a missing field and a user id (the caller is the token)', () => {
    expect(deviceTokenRegisterRequestSchema.safeParse({ ...valid, platform: 'web' }).success).toBe(
      false,
    );
    expect(deviceTokenRegisterRequestSchema.safeParse({ token: valid.token }).success).toBe(false);
    expect(
      deviceTokenRegisterRequestSchema.safeParse({
        ...valid,
        user_id: '6f1d1c5e-6f0b-4e0e-9c57-0f6a3f1f8a11',
      }).success,
    ).toBe(false);
  });
});

describe('deviceTokenRegisterResponseSchema', () => {
  it('is strict: no user id or row id leaves the API', () => {
    const device_token = {
      token: 'ExponentPushToken[abc]',
      platform: 'IOS',
      updated_at: '2026-10-03T10:00:00.000Z',
    };
    expect(deviceTokenRegisterResponseSchema.safeParse({ device_token }).success).toBe(true);
    expect(
      deviceTokenRegisterResponseSchema.safeParse({
        device_token: { ...device_token, user_id: '6f1d1c5e-6f0b-4e0e-9c57-0f6a3f1f8a11' },
      }).success,
    ).toBe(false);
  });
});

describe('orderPushDataSchema', () => {
  const data = {
    type: 'order.state_changed',
    notification_id: '0b0f2a0e-6a52-4a0d-8a43-3f5a4a1f6f10',
    order_id: '6f1d1c5e-6f0b-4e0e-9c57-0f6a3f1f8a11',
    state: 'OUT_FOR_DELIVERY',
    audience: 'CUSTOMER',
    data_only: true,
    title: 'Your order is on its way',
    body: 'Order #1F8A11 has left the shop.',
  };

  it('accepts the worker payload and tolerates extra keys a push service adds', () => {
    expect(orderPushDataSchema.parse(data)).toEqual(data);
    expect(orderPushDataSchema.safeParse({ ...data, experienceId: '@x/y' }).success).toBe(true);
  });

  it('refuses another type, an unknown state and a blank title', () => {
    expect(orderPushDataSchema.safeParse({ ...data, type: 'chat' }).success).toBe(false);
    expect(orderPushDataSchema.safeParse({ ...data, state: 'ARRIVED' }).success).toBe(false);
    expect(orderPushDataSchema.safeParse({ ...data, title: '' }).success).toBe(false);
  });
});

describe('the order alarm sound (2026-10-22)', () => {
  it('has a valid Android resource name and is its .wav file', () => {
    // Android: start with a letter; only lowercase a-z, 0-9 and underscores (EAS prebuild refuses
    // anything else).
    expect(ORDER_ALARM_SOUND_RESOURCE).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(ORDER_ALARM_SOUND).toBe('vendor_alarm.wav');
  });

  it('rings on a channel that never carried the old, invalid sound name', () => {
    expect(LEGACY_ORDER_ALARM_CHANNEL_IDS).toContain('order-alarm');
    expect(LEGACY_ORDER_ALARM_CHANNEL_IDS).not.toContain(ORDER_ALARM_CHANNEL_ID);
  });
});

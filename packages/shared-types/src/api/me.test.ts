import { mePatchRequestSchema, notificationListQuerySchema } from './me';

describe('PATCH /api/me body', () => {
  it('normalises the name and the email', () => {
    expect(
      mePatchRequestSchema.parse({ full_name: '  Sita   Gurung ', email: ' Sita@Example.COM ' }),
    ).toEqual({ full_name: 'Sita Gurung', email: 'sita@example.com' });
  });

  it('takes a cleared email and the accepted terms, and nothing that names the account', () => {
    expect(mePatchRequestSchema.safeParse({ email: null }).success).toBe(true);
    expect(mePatchRequestSchema.safeParse({ accept_terms: true }).success).toBe(true);
    for (const body of [
      {},
      { accept_terms: false },
      { role: 'VENDOR' },
      { user_id: '11111111-1111-4111-8111-111111111111' },
      { full_name: 'A' },
    ]) {
      expect(mePatchRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('notification list query', () => {
  it('defaults to 20 and caps at 50', () => {
    expect(notificationListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(notificationListQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(notificationListQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });
});

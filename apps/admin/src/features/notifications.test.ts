import { ApiError } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import {
  addVendors,
  confirmationText,
  counter,
  pushOutcomeText,
  removeVendor,
  sendErrorMessage,
  sentText,
  validateDraft,
  vendorLabel,
  type ChosenVendor,
} from './notifications/notification-rules';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const shop = (n: number, name = `Shop ${String(n)}`): ChosenVendor => ({
  id: uuid(n),
  vendor_code: `HPV-${String(n).padStart(5, '0')}`,
  business_name: name,
});

describe('Notifications tab rules (step 7.5)', () => {
  it('always names a shop with its Vendor Code', () => {
    expect(vendorLabel(shop(42, 'Thamel Kirana Pasal'))).toBe('Thamel Kirana Pasal · HPV-00042');
  });

  it('adds each shop once and keeps the order chosen', () => {
    const first = addVendors([], [shop(1), shop(2)]);
    expect(first.ok).toBe(true);
    const again = addVendors(first.chosen, [shop(2), shop(3)]);
    expect(again).toMatchObject({ ok: true, added: 1 });
    expect(again.chosen.map((v) => v.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(removeVendor(again.chosen, uuid(2)).map((v) => v.id)).toEqual([uuid(1), uuid(3)]);
  });

  it('allows exactly 500 shops and refuses a batch that would pass it', () => {
    const many = Array.from({ length: 500 }, (_, i) => shop(i + 1));
    const full = addVendors([], many);
    expect(full).toMatchObject({ ok: true, added: 500 });

    const over = addVendors(full.chosen, [shop(999)]);
    expect(over.ok).toBe(false);
    expect(over.chosen).toHaveLength(500);
    if (!over.ok) expect(over.error).toBe('At most 500 shops per message (0 more can be added).');

    // A batch larger than the room left adds none of it.
    const partly = addVendors(many.slice(0, 498), [shop(1001), shop(1002), shop(1003)]);
    expect(partly.ok).toBe(false);
    expect(partly.chosen).toHaveLength(498);
  });

  it('counts characters against the limit', () => {
    expect(counter('  Festival hours ', 60)).toBe('14 / 60');
  });

  it('builds the request, or says what is missing', () => {
    const base = { title: ' Festival hours ', body: 'Update your hours.', deepLink: '' };
    expect(validateDraft({ audience: 'VENDORS', chosen: [], ...base })).toEqual({
      ok: false,
      error: 'Choose at least one shop.',
    });
    expect(validateDraft({ audience: 'VENDORS', chosen: [shop(1)], ...base, title: ' ' })).toEqual({
      ok: false,
      error: 'Write a title.',
    });
    expect(
      validateDraft({ audience: 'VENDORS', chosen: [shop(1)], ...base, title: 'x'.repeat(61) }),
    ).toMatchObject({ ok: false });
    expect(
      validateDraft({
        audience: 'VENDORS',
        chosen: [shop(1)],
        ...base,
        deepLink: 'https://x.test',
      }),
    ).toEqual({
      ok: false,
      error: 'The link must be an app path starting with /, such as /orders.',
    });

    expect(
      validateDraft({
        audience: 'VENDORS',
        chosen: [shop(1), shop(2)],
        ...base,
        deepLink: '/settings',
      }),
    ).toEqual({
      ok: true,
      request: {
        audience: 'VENDORS',
        vendor_ids: [uuid(1), uuid(2)],
        title: 'Festival hours',
        body: 'Update your hours.',
        deep_link: '/settings',
      },
    });
    expect(validateDraft({ audience: 'ALL_CUSTOMERS', chosen: [shop(1)], ...base })).toEqual({
      ok: true,
      request: { audience: 'ALL_CUSTOMERS', title: 'Festival hours', body: 'Update your hours.' },
    });
  });

  it('names the recipients in the confirmation and the answer', () => {
    expect(
      confirmationText({ audience: 'VENDORS', chosen: [shop(42, 'Thamel Kirana Pasal')] }),
    ).toBe('Send to 1 shop: Thamel Kirana Pasal · HPV-00042?');
    expect(confirmationText({ audience: 'VENDORS', chosen: [shop(1), shop(2)] })).toBe(
      'Send to 2 shops?',
    );
    expect(confirmationText({ audience: 'ALL_CUSTOMERS', chosen: [] })).toMatch(/^Send to ALL/);
    expect(sentText('VENDORS', 500)).toBe('Sent to 500 shops.');
    expect(sentText('ALL_CUSTOMERS', 1234)).toBe('Sent to all customers (1234 accounts).');
  });

  it('explains refusals', () => {
    expect(
      sendErrorMessage(
        new ApiError(429, 'BROADCAST_RATE_LIMITED', 'x', { retry_after_seconds: 250 }),
      ),
    ).toBe('Only one message to all customers every 10 minutes. Try again in 5 min.');
    expect(sendErrorMessage(new ApiError(422, 'VENDOR_NOT_FOUND', 'x'))).toMatch(/no longer exist/);
    expect(sendErrorMessage(new Error('boom'))).toBe('The message could not be sent.');
  });

  it('shows the push outcome once the worker recorded it', () => {
    expect(pushOutcomeText({ push_sent: null, push_failed: null, push_completed_at: null })).toBe(
      'Pushing…',
    );
    expect(
      pushOutcomeText({ push_sent: 12, push_failed: 0, push_completed_at: '2026-10-16T08:00:00Z' }),
    ).toBe('12 devices');
    expect(
      pushOutcomeText({ push_sent: 10, push_failed: 2, push_completed_at: '2026-10-16T08:00:00Z' }),
    ).toBe('10 devices, 2 failed');
  });
});

describe('admin push API client (step 7.5)', () => {
  it('searches shops by name or code and parses the Vendor Code', async () => {
    const { api, calls } = fakeAdminApi(() => ({
      body: {
        vendors: [
          {
            id: uuid(1),
            vendor_code: 'HPV-00001',
            business_name: 'Thamel Kirana Pasal',
            municipality_palika_string: 'Kathmandu Metropolitan City',
            status: 'LIVE',
          },
        ],
      },
    }));
    const found = await api.searchVendors('thamel kirana');
    expect(calls[0]?.call).toBe('GET /api/admin/vendors/search?q=thamel%20kirana');
    expect(found.vendors[0]?.vendor_code).toBe('HPV-00001');
  });

  it('sends a message and answers the recipient count', async () => {
    const { api, calls } = fakeAdminApi(() => ({
      status: 202,
      body: { message_id: uuid(9), recipient_count: 2 },
    }));
    const request = {
      audience: 'VENDORS' as const,
      vendor_ids: [uuid(1), uuid(2)],
      title: 'Hi',
      body: 'Hello.',
    };
    await expect(api.sendNotification(request)).resolves.toEqual({
      message_id: uuid(9),
      recipient_count: 2,
    });
    expect(calls[0]).toEqual({ call: 'POST /api/admin/notifications', body: request });
  });

  it('surfaces the rate limit as an ApiError with its details', async () => {
    const { api } = fakeAdminApi(() =>
      refusalOf(429, 'BROADCAST_RATE_LIMITED', { retry_after_seconds: 30 }),
    );
    await expect(
      api.sendNotification({ audience: 'ALL_CUSTOMERS', title: 'Hi', body: 'Hello.' }),
    ).rejects.toMatchObject({ status: 429, code: 'BROADCAST_RATE_LIMITED' });
  });

  it('pages the history with a cursor', async () => {
    const { api, calls } = fakeAdminApi(() => ({ body: { notifications: [], next_cursor: null } }));
    await api.listNotifications(uuid(3));
    expect(calls[0]?.call).toBe(`GET /api/admin/notifications?cursor=${uuid(3)}`);
  });
});

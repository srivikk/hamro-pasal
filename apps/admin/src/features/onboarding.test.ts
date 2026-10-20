import type { AdminVendorView } from '@hamro-pasal/shared-types';

import { ApiError } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import {
  nepalPhone,
  onboardingErrorMessage,
  sandboxedShops,
  toggledTutorial,
  validateShopDraft,
  validateTutorialDraft,
  youtubeVideoId,
} from './onboarding/onboarding-rules';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const shop = {
  phone: '980-000-0001',
  businessName: 'Thamel Kirana Pasal',
  palika: 'Kathmandu Metropolitan City',
  lat: '27.7154',
  lng: '85.3123',
  fulfillment: 'SELF_DELIVERY' as const,
  approveNow: false,
};

describe('Onboarding tab rules (step 7.7)', () => {
  it('normalises the owner’s number to +977', () => {
    expect(nepalPhone('9800000001')).toBe('+9779800000001');
    expect(nepalPhone('+977 980-000-0001')).toBe('+9779800000001');
  });

  it('builds the request, SANDBOXED unless approved now', () => {
    expect(validateShopDraft(shop)).toEqual({
      ok: true,
      request: {
        phone: '+9779800000001',
        business_name: 'Thamel Kirana Pasal',
        municipality_palika_string: 'Kathmandu Metropolitan City',
        location: { lat: 27.7154, lng: 85.3123 },
        fulfillment_mode: 'SELF_DELIVERY',
        delivery_scope: 'RADIUS_BOUND',
        radius_km: 3,
        status: 'SANDBOXED',
      },
    });
    expect(validateShopDraft({ ...shop, approveNow: true })).toMatchObject({
      ok: true,
      request: { status: 'APPROVED' },
    });
  });

  it('says what is wrong: the number, the name, a location outside Nepal', () => {
    expect(validateShopDraft({ ...shop, phone: '12345' })).toEqual({
      ok: false,
      error: 'Enter a 10-digit Nepal mobile number starting with 9.',
    });
    expect(validateShopDraft({ ...shop, businessName: 'X' })).toMatchObject({ ok: false });
    expect(validateShopDraft({ ...shop, lat: '51.5', lng: '-0.12' })).toEqual({
      ok: false,
      error: 'Enter the shop’s latitude and longitude, inside Nepal.',
    });
  });

  it('lists the shops waiting for approval, oldest first', () => {
    const vendor = (n: number, status: string, created: string) =>
      ({ id: ID(n), status, created_at: created }) as unknown as AdminVendorView;
    expect(
      sandboxedShops([
        vendor(1, 'LIVE', '2026-10-01T00:00:00Z'),
        vendor(2, 'SANDBOXED', '2026-10-10T00:00:00Z'),
        vendor(3, 'SANDBOXED', '2026-10-05T00:00:00Z'),
        vendor(4, 'APPROVED', '2026-09-30T00:00:00Z'), // left there by the earlier rule
        vendor(5, 'SUSPENDED_COMPLIANCE', '2026-09-29T00:00:00Z'),
      ]).map((v) => v.id),
    ).toEqual([ID(4), ID(3), ID(2)]);
  });

  it('names the missing KYC documents', () => {
    expect(
      onboardingErrorMessage(
        new ApiError(422, 'KYC_INCOMPLETE', 'x', { missing: ['PAN_DOCUMENT', 'TAX_ID'] }),
      ),
    ).toBe('Not ready to approve: missing PAN document, PAN number.');
    expect(onboardingErrorMessage(new ApiError(409, 'DEFAULT_PLAN_REQUIRED', 'x'))).toBe(
      'Publish a default Commission plan (Pricing plans) before approving a shop.',
    );
    expect(onboardingErrorMessage(new ApiError(409, 'ALREADY_A_SELLER', 'x'))).toBe(
      'This number already has a shop.',
    );
  });
});

describe('Tutorials tab rules (step 7.8)', () => {
  it('reads the video id from any YouTube link or a bare id', () => {
    for (const link of [
      'dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?list=x&v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(youtubeVideoId(link)).toBe('dQw4w9WgXcQ');
    }
    expect(youtubeVideoId('https://vimeo.com/123')).toBeNull();
  });

  it('builds the request, and toggles a video without changing anything else', () => {
    expect(
      validateTutorialDraft({
        app: 'SELLER',
        video: 'https://youtu.be/dQw4w9WgXcQ',
        title: ' Add a product ',
        displayOrder: '2',
      }),
    ).toEqual({
      ok: true,
      request: {
        app: 'SELLER',
        youtube_video_id: 'dQw4w9WgXcQ',
        title: 'Add a product',
        display_order: 2,
        is_active: true,
      },
    });
    expect(
      validateTutorialDraft({ app: 'CUSTOMER', video: 'nope', title: 'x', displayOrder: '' }),
    ).toMatchObject({ ok: false });
    expect(
      toggledTutorial({
        id: ID(1),
        app: 'CUSTOMER',
        youtube_video_id: 'dQw4w9WgXcQ',
        title: 'Order',
        display_order: 1,
        is_active: true,
      }),
    ).toEqual({
      app: 'CUSTOMER',
      youtube_video_id: 'dQw4w9WgXcQ',
      title: 'Order',
      display_order: 1,
      is_active: false,
    });
  });
});

describe('onboarding and tutorial API client', () => {
  it('creates a shop and approves one', async () => {
    const { api, calls } = fakeAdminApi((call) =>
      call.startsWith('POST /api/admin/vendors/')
        ? { body: { vendor_id: ID(1), status: 'APPROVED' } }
        : {
            status: 201,
            body: {
              vendor_id: ID(1),
              vendor_code: 'HPV-00042',
              user_id: ID(2),
              status: 'SANDBOXED',
              account_created: true,
              invite_sent: true,
            },
          },
    );
    const request = validateShopDraft(shop);
    if (!request.ok) throw new Error('draft');
    await expect(api.createVendor(request.request)).resolves.toMatchObject({
      vendor_code: 'HPV-00042',
    });
    await expect(api.approveVendor(ID(1))).resolves.toEqual({
      vendor_id: ID(1),
      status: 'APPROVED',
    });
    expect(calls.map((c) => c.call)).toEqual([
      'POST /api/admin/vendors',
      `POST /api/admin/vendors/${ID(1)}/approve`,
    ]);
  });

  it('surfaces KYC_INCOMPLETE, and deletes a tutorial', async () => {
    const { api } = fakeAdminApi(() =>
      refusalOf(422, 'KYC_INCOMPLETE', { missing: ['CITIZENSHIP_DOCUMENT'] }),
    );
    await expect(api.approveVendor(ID(1))).rejects.toMatchObject({ code: 'KYC_INCOMPLETE' });

    const deleting = fakeAdminApi(() => ({}));
    await expect(deleting.api.deleteTutorial(ID(3))).resolves.toBeUndefined();
    expect(deleting.calls[0]?.call).toBe(`DELETE /api/admin/tutorials/${ID(3)}`);
  });
});

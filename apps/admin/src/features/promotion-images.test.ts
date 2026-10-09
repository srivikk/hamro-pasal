import { complianceVendorViewSchema } from '@hamro-pasal/shared-types';

import { createAdminApi } from '../api/admin-api';
import { ApiError, createApiClient, type FetchLike } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import { createSessionStore } from '../auth/session-store';
import { panDocumentErrorMessage } from './compliance/compliance-rules';
import {
  PROMOTION_IMAGE_ACCEPT,
  promotionImageProblem,
  promotionImageUploadError,
  unusedUploads,
} from './promotions/promotion-rules';

const CDN = 'https://cdn.hamropasal.test/promotions';
const VENDOR = '11111111-1111-4111-8111-111111111111';
const ADMIN = {
  id: '00000000-0000-4000-8000-000000000099',
  role: 'SUPER_ADMIN',
  first_name: null,
} as const;

describe('promotion artwork: the file picker', () => {
  it('accepts the three image types the server stores', () => {
    expect(PROMOTION_IMAGE_ACCEPT).toBe('image/jpeg,image/png,image/webp');
  });

  it('refuses a wrong type, an empty file and one over 5 MB before any request', () => {
    const file = (type: string, size: number) => ({ name: 'banner', type, size });

    expect(promotionImageProblem(file('image/jpeg', 2000))).toBeNull();
    expect(promotionImageProblem(file('image/webp', 5 * 1024 * 1024))).toBeNull();
    expect(promotionImageProblem(file('image/gif', 2000))).toBe(
      'banner is not a JPEG, PNG or WebP image.',
    );
    expect(promotionImageProblem(file('application/pdf', 2000))).not.toBeNull();
    expect(promotionImageProblem(file('', 2000))).not.toBeNull();
    expect(promotionImageProblem(file('image/png', 0))).toBe('banner is empty.');
    expect(promotionImageProblem(file('image/png', 5 * 1024 * 1024 + 1))).toBe(
      'banner is larger than 5 MB.',
    );
  });

  it('words the refusals of the server', () => {
    expect(promotionImageUploadError(new ApiError(413, 'FILE_TOO_LARGE', 'x'))).toBe(
      'The image is larger than 5 MB.',
    );
    expect(promotionImageUploadError(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'x'))).toBe(
      'This file is not a readable JPEG, PNG or WebP image.',
    );
    expect(promotionImageUploadError(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached. Try again.',
    );
    expect(promotionImageUploadError(new Error('boom'))).toBe(
      'The image could not be uploaded. Try again.',
    );
  });

  it('knows which uploads a closing form leaves unused', () => {
    const [a, b, c] = [`${CDN}/a.webp`, `${CDN}/b.webp`, `${CDN}/c.webp`];

    // Cancelled: everything uploaded while the form was open goes.
    expect(unusedUploads([a, b], null)).toEqual([a, b]);
    // Saved with the last one: the earlier tries go, the saved image stays.
    expect(unusedUploads([a, b, c], c)).toEqual([a, b]);
    // Saved with the image the promotion already had: every upload of this sitting goes.
    expect(unusedUploads([a], 'https://elsewhere.test/old.png')).toEqual([a]);
    expect(unusedUploads([a, a], null)).toEqual([a]);
    expect(unusedUploads([], c)).toEqual([]);
  });
});

describe('createAdminApi (Phase 34 endpoints)', () => {
  function recording(respond: () => Response) {
    const calls: {
      call: string;
      authorization: string | null;
      contentType: string | null;
      body: unknown;
    }[] = [];
    const fetch: FetchLike = (url, init) => {
      const headers = new Headers(init.headers);
      calls.push({
        call: `${init.method ?? ''} ${url}`,
        authorization: headers.get('authorization'),
        contentType: headers.get('content-type'),
        body: init.body,
      });
      return Promise.resolve(respond());
    };
    const session = createSessionStore();
    session
      .getState()
      .setSession({ phone: '+9779800000099', user: ADMIN, accessToken: 'access-1' });
    return { calls, api: createAdminApi(createApiClient({ baseUrl: '', fetch, session })) };
  }

  it('uploads the image as one `image` part and leaves the boundary to the browser', async () => {
    const { calls, api } = recording(
      () => new Response(JSON.stringify({ url: `${CDN}/a.webp` }), { status: 201 }),
    );
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'dashain.jpg', {
      type: 'image/jpeg',
    });

    await expect(api.uploadPromotionImage(file)).resolves.toEqual({ url: `${CDN}/a.webp` });

    const [call] = calls;
    expect(call?.call).toBe('POST /api/admin/promotions/image');
    expect(call?.authorization).toBe('Bearer access-1');
    expect(call?.contentType).toBeNull();
    const form = call?.body;
    if (!(form instanceof FormData)) throw new Error('the body is not a FormData');
    expect([...form.keys()]).toEqual(['image']);
    const part = form.get('image') as File;
    expect([part.name, part.type, part.size]).toEqual(['dashain.jpg', 'image/jpeg', 3]);
  });

  it('refuses an answer that is not a public URL', async () => {
    const { api } = recording(
      () => new Response(JSON.stringify({ url: 'kyc/pan/somewhere.webp' }), { status: 201 }),
    );

    await expect(
      api.uploadPromotionImage(new File(['x'], 'a.png', { type: 'image/png' })),
    ).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('discards an unused image by its URL, and passes on a refusal', async () => {
    const ok = fakeAdminApi(() => ({}));
    await expect(ok.api.discardPromotionImage(`${CDN}/a.webp`)).resolves.toBeUndefined();
    expect(ok.calls).toEqual([
      { call: 'DELETE /api/admin/promotions/image', body: { url: `${CDN}/a.webp` } },
    ]);

    const inUse = fakeAdminApi(() => refusalOf(409, 'PROMOTION_IMAGE_IN_USE'));
    await expect(inUse.api.discardPromotionImage(`${CDN}/a.webp`)).rejects.toMatchObject({
      status: 409,
      code: 'PROMOTION_IMAGE_IN_USE',
    });
  });

  it('downloads a PAN document as a Blob, with the admin token', async () => {
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
    const { calls, api } = recording(
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/webp' } }),
    );

    const blob = await api.getVendorPanDocument(VENDOR);

    expect(calls).toEqual([
      {
        call: `GET /api/admin/vendors/${VENDOR}/pan-document`,
        authorization: 'Bearer access-1',
        contentType: null,
        body: undefined,
      },
    ]);
    expect(blob.type).toBe('image/webp');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it('turns a refused download into the API error, and words it', async () => {
    const { api } = recording(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'PAN_DOCUMENT_NOT_FOUND', message: 'none' } }),
          { status: 404 },
        ),
    );

    const error: unknown = await api
      .getVendorPanDocument(VENDOR)
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 404, code: 'PAN_DOCUMENT_NOT_FOUND' });
    expect(panDocumentErrorMessage(error)).toBe(
      'This vendor has no document on file any more. Refresh the list.',
    );
    expect(panDocumentErrorMessage(new ApiError(0, 'NETWORK_ERROR', 'x'))).toBe(
      'The API cannot be reached. Try again.',
    );
  });

  it('renews an expired token once for a download, like any other call', async () => {
    let downloads = 0;
    const session = createSessionStore();
    session.getState().setSession({ phone: '+9779800000099', user: ADMIN, accessToken: 'expired' });
    const seen: (string | null)[] = [];
    const fetch: FetchLike = (url, init) => {
      if (url === '/api/auth/refresh') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token_type: 'Bearer',
              access_token: 'fresh',
              access_token_expires_in: 900,
              user: { ...ADMIN, phone: '+9779800000099' },
            }),
            { status: 200 },
          ),
        );
      }
      seen.push(new Headers(init.headers).get('authorization'));
      downloads += 1;
      return Promise.resolve(
        downloads === 1
          ? new Response(
              JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
              { status: 401 },
            )
          : new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      );
    };
    const api = createAdminApi(createApiClient({ baseUrl: '', fetch, session }));

    const blob = await api.getVendorPanDocument(VENDOR);

    expect(blob.size).toBe(3);
    expect(seen).toEqual(['Bearer expired', 'Bearer fresh']);
  });
});

describe('the compliance contract', () => {
  const vendor = {
    id: VENDOR,
    business_name: 'Asan Masala & Snacks',
    phone: '+9779800000015',
    municipality_palika_string: 'Kathmandu Metropolitan City',
    status: 'LIVE',
    restore_status: null,
    compliance_suspended_at: null,
    legal_name: null,
    tax_id: '301456789',
    is_vat_registered: false,
    pan_verified_at: null,
  };

  it('carries whether a document was uploaded, false for an API from before the field', () => {
    expect(complianceVendorViewSchema.parse(vendor).has_pan_document).toBe(false);
    expect(
      complianceVendorViewSchema.parse({ ...vendor, has_pan_document: true }).has_pan_document,
    ).toBe(true);
    // Where the document is stored is never part of the view.
    expect(
      complianceVendorViewSchema.safeParse({ ...vendor, pan_document_url: 'kyc/pan/x.webp' })
        .success,
    ).toBe(false);
  });
});

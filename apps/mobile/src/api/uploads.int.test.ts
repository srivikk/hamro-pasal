import { http, HttpResponse } from 'msw';

import { errorBody, evidenceUpload, ORDER_ID } from '../test/api-fixtures';
import { apiUrl, server, setupApiTestEnvironment, TEST_ACCESS_TOKEN } from '../test/msw';
import { DISPUTE_EVIDENCE_PATH, EvidenceRejectedError, uploadDisputeEvidence } from './uploads';

setupApiTestEnvironment();

const PHOTO = { uri: 'file:///honey.jpg', mimeType: 'image/jpeg', fileSize: 120_000 };

interface ReceivedUpload {
  authorization: string | null;
  contentType: string | null;
  orderId: string | null;
  hasFile: boolean;
}

function serveUpload(respond: () => Response) {
  const received: ReceivedUpload[] = [];
  server.use(
    http.post(apiUrl(DISPUTE_EVIDENCE_PATH), async ({ request }) => {
      const raw = await request.text();
      received.push({
        authorization: request.headers.get('authorization'),
        contentType: request.headers.get('content-type'),
        orderId: /name="order_id"\r\n\r\n([^\r]*)/.exec(raw)?.[1] ?? null,
        hasFile: raw.includes('name="file"'),
      });
      return respond();
    }),
  );
  return received;
}

describe('POST /api/uploads/dispute-evidence', () => {
  it('sends a multipart order_id + file and returns the attachment', async () => {
    const received = serveUpload(() => HttpResponse.json(evidenceUpload(), { status: 201 }));

    const attachment = await uploadDisputeEvidence(ORDER_ID, PHOTO);

    expect(received).toEqual([
      {
        authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
        contentType: expect.stringMatching(/^multipart\/form-data; boundary=/) as string,
        orderId: ORDER_ID,
        hasFile: true,
      },
    ]);
    expect(attachment).toEqual(evidenceUpload());
  });

  it.each([
    ['413 FILE_TOO_LARGE', 'FILE_TOO_LARGE', 413, 'too_large'],
    ['415 UNSUPPORTED_MEDIA_TYPE', 'UNSUPPORTED_MEDIA_TYPE', 415, 'not_an_image'],
    ['422 DISPUTE_WINDOW_CLOSED', 'DISPUTE_WINDOW_CLOSED', 422, 'window_closed'],
  ])('maps %s to a rejection reason', async (_label, code, status, reason) => {
    serveUpload(() => HttpResponse.json(errorBody(code), { status }));

    const error = await uploadDisputeEvidence(ORDER_ID, PHOTO).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EvidenceRejectedError);
    expect(error).toMatchObject({ reason });
  });

  it('refuses files over 5 MB and non-images before sending anything', async () => {
    const received = serveUpload(() => HttpResponse.json(evidenceUpload(), { status: 201 }));

    await expect(
      uploadDisputeEvidence(ORDER_ID, { ...PHOTO, fileSize: 5 * 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({ reason: 'too_large' });
    await expect(
      uploadDisputeEvidence(ORDER_ID, { ...PHOTO, mimeType: 'video/mp4' }),
    ).rejects.toMatchObject({ reason: 'not_an_image' });
    expect(received).toEqual([]);

    await expect(
      uploadDisputeEvidence(ORDER_ID, { ...PHOTO, fileSize: 5 * 1024 * 1024 }),
    ).resolves.toEqual(evidenceUpload());
  });

  it('lets other failures surface unchanged', async () => {
    serveUpload(() => HttpResponse.json(errorBody('ORDER_NOT_FOUND'), { status: 404 }));

    await expect(uploadDisputeEvidence(ORDER_ID, PHOTO)).rejects.toMatchObject({
      status: 404,
      code: 'ORDER_NOT_FOUND',
    });
  });
});

import { ApiError } from '../api/client';
import { fakeAdminApi, refusalOf } from '../api/fake-admin-api';
import { exportErrorMessage, queuedText, validateExportDraft } from './exports/export-rules';

const VENDOR = '00000000-0000-4000-8000-000000000001';

describe('Exports tab rules (step 7.6)', () => {
  it('builds the request, with the shop filter only where it applies', () => {
    expect(
      validateExportDraft({
        kind: 'ORDERS',
        from: '2026-10-01',
        to: '2026-10-16',
        vendorId: ` ${VENDOR} `,
      }),
    ).toEqual({
      ok: true,
      request: { kind: 'ORDERS', from: '2026-10-01', to: '2026-10-16', vendor_id: VENDOR },
    });
    expect(
      validateExportDraft({
        kind: 'CUSTOMERS',
        from: '2026-10-01',
        to: '2026-10-16',
        vendorId: VENDOR,
      }),
    ).toEqual({ ok: true, request: { kind: 'CUSTOMERS', from: '2026-10-01', to: '2026-10-16' } });
  });

  it('refuses a reversed range, more than a year, and a malformed shop id', () => {
    expect(
      validateExportDraft({ kind: 'ORDERS', from: '2026-10-16', to: '2026-10-01', vendorId: '' }),
    ).toMatchObject({ ok: false });
    expect(
      validateExportDraft({ kind: 'ORDERS', from: '2024-01-01', to: '2026-01-01', vendorId: '' }),
    ).toMatchObject({ ok: false });
    expect(
      validateExportDraft({
        kind: 'PAYOUTS',
        from: '2026-10-01',
        to: '2026-10-16',
        vendorId: 'abc',
      }),
    ).toEqual({ ok: false, error: 'The shop filter must be a vendor id.' });
  });

  it('says a large export is emailed, and explains refusals', () => {
    expect(queuedText({ row_count: 12_000 })).toMatch(/^12000 rows: more than 5000, so the export/);
    expect(exportErrorMessage(new ApiError(422, 'EMAIL_REQUIRED', 'x'))).toMatch(/email address/);
    expect(exportErrorMessage(new Error('x'))).toBe('The export could not be made.');
  });
});

describe('admin export API client (step 7.6)', () => {
  it('returns the CSV file of a small export with its file name', async () => {
    const { api, calls } = fakeAdminApi(() => ({ body: 'csv' }));
    const answer = await api.requestExport({
      kind: 'VENDORS',
      from: '2026-10-01',
      to: '2026-10-16',
    });
    expect(calls[0]).toEqual({
      call: 'POST /api/admin/exports',
      body: { kind: 'VENDORS', from: '2026-10-01', to: '2026-10-16' },
    });
    expect(answer.kind).toBe('FILE');
  });

  it('returns the job of a queued export', async () => {
    const job = {
      id: VENDOR,
      kind: 'ORDERS',
      status: 'QUEUED',
      row_count: 9000,
      delivery: null,
      downloadable: false,
      error: null,
      created_at: '2026-10-16T08:00:00.000Z',
      finished_at: null,
      expires_at: null,
    };
    const { api } = fakeAdminApi(() => ({ status: 202, body: { job } }));
    await expect(
      api.requestExport({ kind: 'ORDERS', from: '2026-10-01', to: '2026-10-16' }),
    ).resolves.toEqual({ kind: 'QUEUED', job });
  });

  it('surfaces EMAIL_REQUIRED as an ApiError', async () => {
    const { api } = fakeAdminApi(() => refusalOf(422, 'EMAIL_REQUIRED', { row_count: 9000 }));
    await expect(
      api.requestExport({ kind: 'ORDERS', from: '2026-10-01', to: '2026-10-16' }),
    ).rejects.toMatchObject({ status: 422, code: 'EMAIL_REQUIRED' });
  });
});

import { irdReviewReasons, type AdminVendorView } from '@hamro-pasal/shared-types';

import { fakeAdminApi } from '../../api/fake-admin-api';

import {
  approvalQueue,
  dashboardStats,
  shopsByMunicipality,
  REVIEW_REASON_LABELS,
  signupsPerMonth,
  similarityLabel,
} from './dashboard-rules';

let next = 0;
function vendor(overrides: Partial<AdminVendorView>): AdminVendorView {
  next += 1;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    business_name: `Shop ${String(next)}`,
    phone: '+9779800000011',
    status: 'LIVE',
    suspension: 'NONE',
    restore_status: null,
    wallet_balance_npr: 0,
    pricing_model: 'COMMISSION',
    fulfillment_mode: 'SELF_DELIVERY',
    municipality_palika_string: 'Kathmandu Metropolitan City',
    created_at: '2026-10-01T06:00:00.000Z',
    ...overrides,
  };
}

describe('dashboard figures', () => {
  it('counts live, waiting and suspended shops (both kinds of suspension)', () => {
    const stats = dashboardStats([
      vendor({}),
      vendor({}),
      vendor({ status: 'SANDBOXED' }),
      vendor({ status: 'SUSPENDED', suspension: 'DEBT' }),
      vendor({ status: 'SUSPENDED_COMPLIANCE' }),
      vendor({ status: 'APPROVED' }),
      vendor({ status: 'DEACTIVATED' }),
    ]);
    expect(stats).toEqual({ liveShops: 2, awaitingApproval: 1, suspended: 2, totalShops: 7 });
  });

  it('ranks municipalities by shop count, ties by name, and folds the tail into Other', () => {
    const shops = [
      ...['Pokhara', 'Pokhara', 'Pokhara'].map((p) => vendor({ municipality_palika_string: p })),
      ...['Lalitpur', 'Lalitpur'].map((p) => vendor({ municipality_palika_string: p })),
      ...['Bhaktapur', 'Dharan', 'Butwal'].map((p) => vendor({ municipality_palika_string: p })),
    ];
    expect(shopsByMunicipality(shops)).toEqual([
      { label: 'Pokhara', value: 3 },
      { label: 'Lalitpur', value: 2 },
      { label: 'Bhaktapur', value: 1 },
      { label: 'Butwal', value: 1 },
      { label: 'Dharan', value: 1 },
    ]);
    expect(shopsByMunicipality(shops, 3)).toEqual([
      { label: 'Pokhara', value: 3 },
      { label: 'Lalitpur', value: 2 },
      { label: 'Other', value: 3 },
    ]);
  });

  it('counts sign-ups per month in Nepal Time, keeping empty months as 0', () => {
    const now = new Date('2026-10-21T08:00:00.000Z');
    const months = signupsPerMonth(
      [
        vendor({ created_at: '2026-10-02T00:00:00.000Z' }),
        // 30 Sep 20:00 UTC is already 1 Oct in Nepal (UTC+05:45).
        vendor({ created_at: '2026-09-30T20:00:00.000Z' }),
        vendor({ created_at: '2026-08-10T00:00:00.000Z' }),
        // Before the window: not counted.
        vendor({ created_at: '2026-03-10T00:00:00.000Z' }),
      ],
      now,
    );
    expect(months).toEqual([
      { label: 'May', value: 0 },
      { label: 'Jun', value: 0 },
      { label: 'Jul', value: 0 },
      { label: 'Aug', value: 1 },
      { label: 'Sept', value: 0 },
      { label: 'Oct', value: 2 },
    ]);
  });

  it('lists the shops waiting for approval, the longest-waiting first', () => {
    const late = vendor({ status: 'SANDBOXED', created_at: '2026-10-10T00:00:00.000Z' });
    const early = vendor({ status: 'SANDBOXED', created_at: '2026-10-01T00:00:00.000Z' });
    expect(approvalQueue([late, vendor({}), early]).map((v) => v.id)).toEqual([early.id, late.id]);
  });
});

describe('the IRD manual review queue', () => {
  it('words every review reason and the name score', () => {
    for (const reason of irdReviewReasons) {
      expect(REVIEW_REASON_LABELS[reason].length).toBeGreaterThan(0);
    }
    expect(similarityLabel(0.724)).toBe('72% name match (auto-verify needs 85%)');
  });

  it('reads the queue and retries a check through their routes', async () => {
    const checkId = '7b1f0c8e-0000-4000-8000-000000000003';
    const { api, calls } = fakeAdminApi((call) =>
      call.startsWith('GET')
        ? { body: { checks: [] } }
        : { status: 202, body: { check_id: checkId, status: 'QUEUED' } },
    );
    await expect(api.listIrdManualReview()).resolves.toEqual({ checks: [] });
    await expect(api.retryIrdCheck(checkId)).resolves.toEqual({
      check_id: checkId,
      status: 'QUEUED',
    });
    expect(calls.map((call) => call.call)).toEqual([
      'GET /api/admin/kyc/manual-review',
      `POST /api/admin/kyc/checks/${checkId}/retry`,
    ]);
  });
});

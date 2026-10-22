import type { AdminDisputeView } from '@hamro-pasal/shared-types';

import { ApiError } from '../api/client';
import { fakeAdminApi } from '../api/fake-admin-api';
import {
  authLogErrorMessage,
  checkRevealReason,
  countdown,
  eventTone,
  normalisePhone,
} from './auth-logs/auth-log-rules';
import {
  disputeErrorMessage,
  isResolved,
  moneyLine,
  validateResolution,
} from './disputes/dispute-rules';

const DISPUTE: AdminDisputeView = {
  dispute_id: '11111111-1111-4111-8111-111111111111',
  order_id: '22222222-2222-4222-8222-222222222222',
  order_state: 'DISPUTED',
  payment_method: 'ESEWA',
  status: 'ESCALATED',
  vendor_id: '33333333-3333-4333-8333-333333333333',
  business_name: 'Thamel Kirana',
  customer_first_name: 'Aarav',
  order_total_npr: 860,
  held_npr: 769.5,
  escalated_by: 'CUSTOMER',
  escalation_reason: 'The jar arrived broken.',
  escalated_at: '2026-10-21T06:00:00.000Z',
  delivered_at: '2026-10-20T06:00:00.000Z',
  refund_npr: null,
  resolution_note: null,
  resolved_at: null,
};

describe('dispute resolution rules (2026-10-21)', () => {
  const note = 'The shop confirmed the jar was broken.';

  it('builds a release, a full refund and a partial refund with the API schema', () => {
    expect(validateResolution({ outcome: 'RELEASE', refund: '', note }, DISPUTE)).toEqual({
      ok: true,
      request: { outcome: 'RELEASE', note },
    });
    expect(validateResolution({ outcome: 'REFUND', refund: '999', note }, DISPUTE)).toEqual({
      ok: true,
      request: { outcome: 'REFUND', note },
    });
    expect(
      validateResolution({ outcome: 'PARTIAL_REFUND', refund: ' 200.50 ', note }, DISPUTE),
    ).toEqual({ ok: true, request: { outcome: 'PARTIAL_REFUND', refund_npr: 200.5, note } });
  });

  it('refuses a short reason, a bad amount and a partial refund of everything', () => {
    expect(
      validateResolution({ outcome: 'RELEASE', refund: '', note: 'ok' }, DISPUTE),
    ).toMatchObject({
      ok: false,
      errors: { note: expect.stringContaining('10 to 1000') as unknown },
    });
    for (const refund of ['', 'abc', '0', '10.005']) {
      const result = validateResolution({ outcome: 'PARTIAL_REFUND', refund, note }, DISPUTE);
      expect(result.ok).toBe(false);
    }
    expect(
      validateResolution({ outcome: 'PARTIAL_REFUND', refund: '860', note }, DISPUTE),
    ).toMatchObject({
      ok: false,
      errors: { refund: expect.stringContaining('full refund') as unknown },
    });
  });

  it('says where the money is: frozen, with the shop as cash, or settled', () => {
    expect(moneyLine(DISPUTE)).toBe('Rs. 769.50 frozen in escrow until you resolve this.');
    expect(moneyLine({ ...DISPUTE, payment_method: 'COD', held_npr: 0 })).toContain('cash');
    expect(moneyLine({ ...DISPUTE, status: 'REFUNDED_TO_CUSTOMER', refund_npr: 860 })).toBe(
      'Refunded Rs. 860 to the customer.',
    );
    expect(isResolved('RELEASED_TO_VENDOR')).toBe(true);
    expect(isResolved('ESCALATED')).toBe(false);
  });

  it('words the API refusals', () => {
    expect(disputeErrorMessage(new ApiError(409, 'ALREADY_RESOLVED', 'x'))).toContain(
      'Another admin',
    );
    expect(disputeErrorMessage(new ApiError(409, 'ORDER_NOT_DELIVERED', 'x'))).toContain('frozen');
  });
});

describe('authentication log rules (2026-10-21)', () => {
  it('reads a number however it was typed, or not at all', () => {
    expect(normalisePhone('9801234567')).toBe('+9779801234567');
    expect(normalisePhone('+977 980-123-4567')).toBe('+9779801234567');
    expect(normalisePhone('977 9801234567')).toBe('+9779801234567');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('8801234567')).toBeNull();
  });

  it('asks for a real reason before a reveal', () => {
    expect(checkRevealReason('  short ')).toMatchObject({ ok: false });
    expect(checkRevealReason('  SMS delayed, caller verified  ')).toEqual({
      ok: true,
      reason: 'SMS delayed, caller verified',
    });
  });

  it('formats the countdown and the event tones', () => {
    expect(countdown(102)).toBe('1:42');
    expect(countdown(-3)).toBe('0:00');
    expect(eventTone('OTP_SENT')).toBe('ok');
    expect(eventTone('OTP_SEND_FAILED')).toBe('bad');
    expect(eventTone('OTP_WRONG')).toBe('warn');
    expect(authLogErrorMessage(new ApiError(403, 'OTP_REVEAL_DISABLED', 'x'))).toContain(
      'cannot be revealed',
    );
  });
});

describe('admin API: disputes and authentication logs', () => {
  it('calls each endpoint with the right method, path and body', async () => {
    const { calls, api } = fakeAdminApi((call) => {
      if (call.startsWith('GET /api/admin/disputes')) {
        return { body: { disputes: [DISPUTE], next_cursor: null } };
      }
      if (call.startsWith('GET /api/orders/')) return { body: { messages: [] } };
      if (call.startsWith('POST /api/orders/')) {
        return {
          status: 201,
          body: {
            message: {
              id: 'm1',
              client_id: 'c1',
              order_id: DISPUTE.order_id,
              sender: { id: 'a1', first_name: null, role: 'SUPER_ADMIN' },
              body: 'Looking into it',
              attachments: [],
              sent_at: '2026-10-21T06:00:00.000Z',
            },
          },
        };
      }
      if (call.startsWith('POST /api/admin/disputes/')) return { body: { dispute: DISPUTE } };
      if (call.startsWith('GET /api/admin/auth-logs')) {
        return { body: { entries: [], next_cursor: null, reveal_enabled: true } };
      }
      return {
        body: {
          phone: '+9779801234567',
          code: '123456',
          expires_in_seconds: 90,
          attempts_used: 0,
        },
      };
    });

    await api.listDisputes({ status: 'ESCALATED' });
    await api.disputeTranscript(DISPUTE.order_id);
    await api.sendDisputeMessage(DISPUTE.order_id, 'c1', 'Looking into it');
    await api.resolveDispute(DISPUTE.dispute_id, { outcome: 'RELEASE', note: 'Shop was right.' });
    await api.listAuthLogs({ phone: '+9779801234567' });
    await api.revealOtp('+9779801234567', 'SMS delayed, caller verified');

    expect(calls.map(({ call, body }) => ({ call, body }))).toEqual([
      { call: 'GET /api/admin/disputes?status=ESCALATED', body: undefined },
      { call: `GET /api/orders/${DISPUTE.order_id}/chat`, body: undefined },
      {
        call: `POST /api/orders/${DISPUTE.order_id}/chat`,
        body: { client_id: 'c1', body: 'Looking into it' },
      },
      {
        call: `POST /api/admin/disputes/${DISPUTE.dispute_id}/resolve`,
        body: { outcome: 'RELEASE', note: 'Shop was right.' },
      },
      { call: 'GET /api/admin/auth-logs?phone=%2B9779801234567', body: undefined },
      {
        call: 'POST /api/admin/auth-logs/reveal',
        body: { phone: '+9779801234567', reason: 'SMS delayed, caller verified' },
      },
    ]);
  });
});

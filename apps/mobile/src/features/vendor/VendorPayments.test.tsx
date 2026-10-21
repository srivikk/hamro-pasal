import type { VendorBillingView } from '@hamro-pasal/shared-types';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { http, HttpResponse } from 'msw';

import VendorPaymentsScreen from '../../../app/(vendor)/payments';
import { useToastStore } from '../../store/useToastStore';
import {
  apiUrl,
  capture,
  server,
  setupApiTestEnvironment,
  type CapturedRequest,
} from '../../test/msw';
import { renderWithProviders } from '../../test/render';
import {
  choiceOf,
  merchantAccountState,
  methodsOf,
  toggle,
  upcomingChoice,
  upcomingPlanId,
} from './payment-preferences';

setupApiTestEnvironment();

const VENDOR_ID = '7b1f0c8e-0000-4000-8000-0000000000aa';
const STARTER = '7a1e2c3d-0000-4000-8000-000000000001';
const GROWTH = '7a1e2c3d-0000-4000-8000-000000000002';
const CHANGE_ID = '5c0d1e2f-0000-4000-8000-000000000001';
const CYCLE_ENDS = '2026-11-16T18:15:00.000Z';

const plan = (id: string, name: string, fee: number) => ({
  id,
  name,
  model: 'SUBSCRIPTION' as const,
  commission_rate: 0,
  monthly_fee_npr: fee,
  duration_cycles: null,
});

const billing = (overrides: Partial<VendorBillingView> = {}): VendorBillingView => ({
  vendor_id: VENDOR_ID,
  settlement_model: 'PLATFORM_ESCROW',
  pricing_plan: plan(STARTER, 'Starter', 999),
  accepted_payment_methods: ['ESEWA', 'KHALTI', 'COD'],
  billing_cycle_started_at: '2026-10-17T18:15:00.000Z',
  billing_cycle_ends_at: CYCLE_ENDS,
  pending_changes: [],
  self_selectable_plans: [plan(STARTER, 'Starter', 999), plan(GROWTH, 'Growth', 2499)],
  dues: null,
  prepaid_reserve_npr: 5000,
  ...overrides,
});

const pendingMethods = (methods: string[]) => ({
  id: CHANGE_ID,
  setting: 'PAYMENT_METHODS' as const,
  current_value: { methods: ['ESEWA', 'KHALTI', 'COD'] },
  requested_value: { methods },
  status: 'PENDING' as const,
  requested_at: '2026-10-20T06:00:00.000Z',
  effective_from: CYCLE_ENDS,
});

function serve(view: VendorBillingView, banks: unknown[] = []) {
  server.use(
    http.get(apiUrl('/api/vendor/billing'), () => HttpResponse.json(view)),
    http.get(apiUrl('/api/vendor/bank-accounts'), () =>
      HttpResponse.json({ bank_accounts: banks }),
    ),
  );
}

async function open() {
  renderWithProviders(<VendorPaymentsScreen />);
  await screen.findByTestId('payments-current-plan');
}

describe('payment preference rules', () => {
  it('reads COD and Prepayment from the stored methods', () => {
    expect(choiceOf(['COD'])).toEqual({ cod: true, prepayment: false });
    expect(choiceOf(['KHALTI'])).toEqual({ cod: false, prepayment: true });
    expect(choiceOf(['ESEWA', 'KHALTI', 'COD'])).toEqual({ cod: true, prepayment: true });
  });

  it('writes Prepayment as eSewa and Khalti, and never an empty list', () => {
    expect(methodsOf({ cod: true, prepayment: true })).toEqual(['ESEWA', 'KHALTI', 'COD']);
    expect(methodsOf({ cod: false, prepayment: true })).toEqual(['ESEWA', 'KHALTI']);
    expect(methodsOf({ cod: true, prepayment: false })).toEqual(['COD']);
    expect(methodsOf({ cod: false, prepayment: false })).toBeNull();
  });

  it('refuses to switch off the last way to be paid', () => {
    expect(toggle({ cod: true, prepayment: false }, 'cod')).toEqual({
      cod: true,
      prepayment: false,
    });
    expect(toggle({ cod: true, prepayment: true }, 'cod')).toEqual({
      cod: false,
      prepayment: true,
    });
  });

  it('shows what is queued for the next cycle, else what is active', () => {
    expect(upcomingChoice(billing())).toEqual({ cod: true, prepayment: true });
    expect(upcomingChoice(billing({ pending_changes: [pendingMethods(['COD'])] }))).toEqual({
      cod: true,
      prepayment: false,
    });
    expect(upcomingPlanId(billing())).toBeNull();
  });

  it('offers a merchant account to customers only once verified', () => {
    const account = {
      gateway: 'ESEWA' as const,
      merchant_code: 'EPAYSHOP',
      secret_hint: 'ab12',
      verified_at: null,
      updated_at: '2026-10-20T06:00:00.000Z',
    };
    expect(merchantAccountState(undefined)).toBe('MISSING');
    expect(merchantAccountState(account)).toBe('AWAITING_VERIFICATION');
    expect(merchantAccountState({ ...account, verified_at: account.updated_at })).toBe('VERIFIED');
  });
});

describe('Seller App: Payments screen', () => {
  it('queues Cash on Delivery only for the next cycle', async () => {
    serve(billing());
    let sent: CapturedRequest | null = null;
    server.use(
      http.post(apiUrl('/api/vendor/billing/changes'), async ({ request }) => {
        sent = await capture(request);
        return HttpResponse.json({ change: pendingMethods(['COD']) }, { status: 202 });
      }),
    );
    await open();

    expect(screen.getByTestId('payments-methods-save')).toBeDisabled();
    fireEvent(screen.getByTestId('payments-prepayment'), 'valueChange', false);
    fireEvent.press(screen.getByTestId('payments-methods-save'));

    await waitFor(() => {
      expect(sent?.body).toEqual({ setting: 'PAYMENT_METHODS', value: { methods: ['COD'] } });
    });
    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        'Saved. It applies from the next billing cycle.',
      );
    });
  });

  it('keeps one method on: switching off the only one does nothing', async () => {
    serve(billing({ accepted_payment_methods: ['COD'] }));
    await open();

    fireEvent(screen.getByTestId('payments-cod'), 'valueChange', false);

    expect(screen.getByTestId('payments-cod').props.value).toBe(true);
    expect(screen.getByTestId('payments-methods-save')).toBeDisabled();
  });

  it('shows a queued change and withdraws it', async () => {
    serve(billing({ pending_changes: [pendingMethods(['COD'])] }));
    let withdrawn = '';
    server.use(
      http.delete(apiUrl('/api/vendor/billing/changes/:id'), ({ params }) => {
        withdrawn = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await open();

    expect(screen.getByTestId('payments-prepayment').props.value).toBe(false);
    expect(screen.getByTestId('payments-methods-pending')).toBeTruthy();
    fireEvent.press(screen.getByTestId('payments-methods-withdraw'));

    await waitFor(() => {
      expect(withdrawn).toBe(CHANGE_ID);
    });
  });

  it('switches to another Subscription plan; Commission and Free are never offered', async () => {
    serve(billing());
    let sent: CapturedRequest | null = null;
    server.use(
      http.post(apiUrl('/api/vendor/billing/changes'), async ({ request }) => {
        sent = await capture(request);
        return HttpResponse.json({ change: null });
      }),
    );
    await open();

    expect(screen.getByTestId('payments-current-plan')).toHaveTextContent(
      'Starter · Rs. 999 a month',
    );
    expect(screen.getByTestId('payments-plan-save')).toBeDisabled();
    fireEvent.press(screen.getByTestId(`payments-plan-${GROWTH}`));
    fireEvent.press(screen.getByTestId('payments-plan-save'));

    await waitFor(() => {
      expect(sent?.body).toEqual({ setting: 'PRICING_PLAN', value: { pricing_plan_id: GROWTH } });
    });
  });

  it('warns about cycle dues and their deadline', async () => {
    serve(
      billing({
        dues: {
          amount_npr: 150,
          opened_at: '2026-10-17T18:15:00.000Z',
          due_at: '2026-10-24T18:15:00.000Z',
        },
      }),
    );
    await open();

    expect(screen.getByTestId('payments-dues')).toHaveTextContent(/Cycle dues: Rs\. 150/);
  });

  it('a shop paid through the platform is told how direct payments work, without a form', async () => {
    serve(billing());
    await open();

    expect(screen.getByTestId('payments-direct-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('payments-merchant-ESEWA-code')).toBeNull();
  });

  it('a Model C shop saves its own eSewa merchant account, which then awaits verification', async () => {
    serve(billing({ settlement_model: 'DIRECT_PREPAID' }));
    let sent: CapturedRequest | null = null;
    let accounts: unknown[] = [];
    server.use(
      http.get(apiUrl('/api/vendor/gateway-accounts'), () => HttpResponse.json({ accounts })),
      http.put(apiUrl('/api/vendor/gateway-accounts/:gateway'), async ({ request }) => {
        sent = await capture(request);
        const account = {
          gateway: 'ESEWA',
          merchant_code: 'EPAYSHOP',
          secret_hint: '5678',
          verified_at: null,
          updated_at: '2026-10-21T06:00:00.000Z',
        };
        accounts = [account];
        return HttpResponse.json({ account });
      }),
    );
    await open();

    expect(await screen.findByTestId('payments-merchant-ESEWA-state')).toHaveTextContent(
      'No merchant account yet.',
    );
    fireEvent.changeText(screen.getByTestId('payments-merchant-ESEWA-code'), 'EPAYSHOP');
    fireEvent.changeText(screen.getByTestId('payments-merchant-ESEWA-secret'), 'secret-12345678');
    fireEvent.press(screen.getByTestId('payments-merchant-ESEWA-save'));

    await waitFor(() => {
      expect(sent?.url.pathname).toBe('/api/vendor/gateway-accounts/ESEWA');
      expect(sent?.body).toEqual({ merchant_code: 'EPAYSHOP', secret_key: 'secret-12345678' });
    });
    expect(await screen.findByText(/EPAYSHOP \(secret ending 5678\): waiting/)).toBeTruthy();
    // The secret is never kept on screen after it is sent.
    expect(screen.getByTestId('payments-merchant-ESEWA-secret').props.value).toBe('');
  });

  it('a merchant code another shop holds is refused in words', async () => {
    serve(billing({ settlement_model: 'DIRECT_PREPAID' }));
    server.use(
      http.get(apiUrl('/api/vendor/gateway-accounts'), () => HttpResponse.json({ accounts: [] })),
      http.put(apiUrl('/api/vendor/gateway-accounts/:gateway'), () =>
        HttpResponse.json(
          { error: { code: 'MERCHANT_ACCOUNT_TAKEN', message: 'taken' } },
          { status: 409 },
        ),
      ),
    );
    await open();

    fireEvent.changeText(await screen.findByTestId('payments-merchant-KHALTI-code'), 'KHALTISHOP');
    fireEvent.changeText(screen.getByTestId('payments-merchant-KHALTI-secret'), 'live_secret_key');
    fireEvent.press(screen.getByTestId('payments-merchant-KHALTI-save'));

    await waitFor(() => {
      expect(useToastStore.getState().toast?.message).toBe(
        'That merchant code is registered to another shop.',
      );
    });
  });

  it('adds a bank account for payouts', async () => {
    serve(billing());
    let sent: CapturedRequest | null = null;
    server.use(
      http.post(apiUrl('/api/vendor/bank-accounts'), async ({ request }) => {
        sent = await capture(request);
        return HttpResponse.json(
          {
            bank_account: {
              id: '3e2d1c0b-0000-4000-8000-000000000001',
              bank_name: 'Nabil Bank',
              branch_name: 'Thamel',
              account_name: 'Ram Pasal',
              account_number: '0012345678',
              routing_or_swift_code: null,
              is_primary: true,
              created_at: '2026-10-21T06:00:00.000Z',
              updated_at: '2026-10-21T06:00:00.000Z',
            },
          },
          { status: 201 },
        );
      }),
    );
    await open();

    fireEvent.changeText(screen.getByTestId('payments-bank-name'), 'Nabil Bank');
    fireEvent.changeText(screen.getByTestId('payments-bank-branch'), 'Thamel');
    fireEvent.changeText(screen.getByTestId('payments-bank-holder'), 'Ram Pasal');
    fireEvent.changeText(screen.getByTestId('payments-bank-number'), '0012345678');
    fireEvent.press(screen.getByTestId('payments-bank-save'));

    await waitFor(() => {
      expect(sent?.body).toEqual({
        bank_name: 'Nabil Bank',
        branch_name: 'Thamel',
        account_name: 'Ram Pasal',
        account_number: '0012345678',
        routing_or_swift_code: null,
        is_primary: false,
      });
    });
  });
});

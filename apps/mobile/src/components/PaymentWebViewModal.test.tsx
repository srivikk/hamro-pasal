import { act, fireEvent, screen } from '@testing-library/react-native';
import { useState } from 'react';

import {
  esewaTarget,
  khaltiTarget,
  type PaymentRedirect,
  type PaymentTarget,
} from '../features/payment/payment-redirect';
import {
  finishWebViewLoad,
  mockWebView,
  navigateWebView,
  resetMockWebView,
} from '../test/mock-webview';
import { renderWithProviders } from '../test/render';
import { PaymentWebViewModal } from './PaymentWebViewModal';

const ORDER_ID = '0b7e9c1a-2f4d-4c8e-9a6b-1d2e3f4a5b6c';
const SUCCESS = 'https://api.hamropasal.test/payments/esewa/success';
const FAILURE = 'https://api.hamropasal.test/payments/esewa/failure';

const esewaAttempt = (transactionUuid: string) =>
  esewaTarget(ORDER_ID, {
    payment_url: 'https://rc-epay.esewa.com.np/api/epay/main/v2/form',
    method: 'POST',
    fields: {
      total_amount: '1200',
      transaction_uuid: transactionUuid,
      product_code: 'EPAYTEST',
      success_url: SUCCESS,
      failure_url: FAILURE,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
      signature: 'c2lnbmF0dXJl',
    },
  });

const khaltiAttempt = khaltiTarget(ORDER_ID, {
  pidx: 'bZQLD9wRVWo4CdESSfuSsB',
  payment_url: 'https://test-pay.khalti.com/?pidx=bZQLD9wRVWo4CdESSfuSsB',
  expires_at: null,
});

type Redirect = Exclude<PaymentRedirect, { kind: 'none' }>;

/** Owns the target like the cart screen does: a callback or a cancel closes the modal. */
function Harness({
  initial,
  onRedirect,
  onCancel,
  expose,
}: {
  initial: PaymentTarget;
  onRedirect: jest.Mock<undefined, [PaymentTarget, Redirect]>;
  onCancel: jest.Mock<undefined, [PaymentTarget]>;
  expose: (open: (target: PaymentTarget) => void) => void;
}) {
  const [target, setTarget] = useState<PaymentTarget | null>(initial);
  expose(setTarget);
  return (
    <PaymentWebViewModal
      target={target}
      onRedirect={(current, redirect) => {
        onRedirect(current, redirect);
        setTarget(null);
      }}
      onCancel={(current) => {
        onCancel(current);
        setTarget(null);
      }}
    />
  );
}

function renderModal(initial: PaymentTarget) {
  const onRedirect = jest.fn<undefined, [PaymentTarget, Redirect]>();
  const onCancel = jest.fn<undefined, [PaymentTarget]>();
  let open: (target: PaymentTarget) => void = () => undefined;
  renderWithProviders(
    <Harness
      initial={initial}
      onRedirect={onRedirect}
      onCancel={onCancel}
      expose={(fn) => {
        open = fn;
      }}
    />,
  );
  return {
    onRedirect,
    onCancel,
    reopen: (target: PaymentTarget) => {
      act(() => {
        open(target);
      });
    },
  };
}

beforeEach(resetMockWebView);

describe('PaymentWebViewModal', () => {
  it('injects the signed eSewa form as raw HTML', () => {
    const target = esewaAttempt('tx-1');
    renderModal(target);

    expect(screen.getByTestId('payment-webview')).toBeOnTheScreen();
    expect(mockWebView.props?.source).toEqual({
      html: target.method === 'ESEWA' ? target.html : '',
    });
    expect(screen.getByText('Pay with eSewa')).toBeOnTheScreen();
  });

  it('loads the Khalti payment_url', () => {
    renderModal(khaltiAttempt);

    expect(mockWebView.props?.source).toEqual({
      uri: 'https://test-pay.khalti.com/?pidx=bZQLD9wRVWo4CdESSfuSsB',
    });
    expect(screen.getByText('Pay with Khalti')).toBeOnTheScreen();
  });

  it('shows a spinner until the page loads', () => {
    renderModal(khaltiAttempt);

    expect(screen.getByTestId('payment-webview-loading')).toBeOnTheScreen();
    finishWebViewLoad();
    expect(screen.queryByTestId('payment-webview-loading')).toBeNull();
  });

  it('keeps browsing through gateway pages', () => {
    const { onRedirect } = renderModal(esewaAttempt('tx-1'));

    navigateWebView('about:blank');
    navigateWebView('https://rc-epay.esewa.com.np/api/epay/main/v2/form');

    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('payment-webview')).toBeOnTheScreen();
  });

  it('parses the eSewa success redirect and closes', () => {
    const target = esewaAttempt('tx-1');
    const { onRedirect } = renderModal(target);

    navigateWebView(`${SUCCESS}?data=eyJzdGF0dXMiOiJDT01QTEVURSJ9+/=`);

    expect(onRedirect).toHaveBeenCalledWith(target, {
      kind: 'esewa_success',
      data: 'eyJzdGF0dXMiOiJDT01QTEVURSJ9+/=',
    });
    expect(screen.queryByTestId('payment-webview')).toBeNull();
  });

  it('parses the eSewa failure redirect and closes', () => {
    const { onRedirect } = renderModal(esewaAttempt('tx-1'));

    navigateWebView(`${FAILURE}?reason=cancelled`);

    expect(onRedirect).toHaveBeenCalledWith(expect.anything(), { kind: 'failure' });
    expect(screen.queryByTestId('payment-webview')).toBeNull();
  });

  it('parses the Khalti return_url redirect and closes', () => {
    const { onRedirect } = renderModal(khaltiAttempt);

    navigateWebView(
      'https://api.hamropasal.test/payments/khalti/return?pidx=bZQLD9wRVWo4CdESSfuSsB&status=Completed',
    );

    expect(onRedirect).toHaveBeenCalledWith(khaltiAttempt, {
      kind: 'khalti_return',
      pidx: 'bZQLD9wRVWo4CdESSfuSsB',
      status: 'Completed',
    });
    expect(screen.queryByTestId('payment-webview')).toBeNull();
  });

  it('reports only the first callback, even if more navigation events arrive before closing', () => {
    const onRedirect = jest.fn();
    renderWithProviders(
      // Parent that does not close the modal: the component itself must stop at one callback.
      <PaymentWebViewModal
        target={esewaAttempt('tx-1')}
        onRedirect={onRedirect}
        onCancel={jest.fn()}
      />,
    );

    navigateWebView(`${SUCCESS}?data=first`);
    navigateWebView(`${SUCCESS}?data=second`);
    navigateWebView(FAILURE);

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(onRedirect).toHaveBeenCalledWith(expect.anything(), {
      kind: 'esewa_success',
      data: 'first',
    });
  });

  it('starts a fresh session for the next attempt (interception and spinner reset)', () => {
    const { onRedirect, reopen } = renderModal(esewaAttempt('tx-1'));
    finishWebViewLoad();
    navigateWebView(FAILURE);
    expect(screen.queryByTestId('payment-webview')).toBeNull();

    const retry = esewaAttempt('tx-2');
    reopen(retry);

    expect(screen.getByTestId('payment-webview-loading')).toBeOnTheScreen();
    navigateWebView(`${SUCCESS}?data=paid`);
    expect(onRedirect).toHaveBeenCalledTimes(2);
    expect(onRedirect).toHaveBeenLastCalledWith(retry, { kind: 'esewa_success', data: 'paid' });
    expect(screen.queryByTestId('payment-webview')).toBeNull();
  });

  it('closes on Cancel without reporting a redirect', () => {
    const { onRedirect, onCancel } = renderModal(khaltiAttempt);

    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledWith(khaltiAttempt);
    expect(onRedirect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('payment-webview')).toBeNull();
  });

  it('renders nothing while there is no target', () => {
    renderWithProviders(
      <PaymentWebViewModal target={null} onRedirect={jest.fn()} onCancel={jest.fn()} />,
    );

    expect(screen.queryByTestId('payment-webview')).toBeNull();
    expect(mockWebView.renders).toBe(0);
  });
});

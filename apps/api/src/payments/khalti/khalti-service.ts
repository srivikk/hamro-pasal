import { orders, type Database } from '@hamro-pasal/db';
import { and, eq } from 'drizzle-orm';

import type { CheckoutService } from '../../checkout/checkout-service';
import { PaymentGatewayError } from '../gateway-http';
import { assertPayable } from '../payable-order';
import {
  orderTotalPaisa,
  PaymentNotFoundError,
  type ConfirmedPayment,
  type PaymentConfirmationService,
} from '../payment-confirmation';
import type { VendorGatewayAccountService } from '../gateway-accounts';
import { KHALTI_COMPLETED, type KhaltiClient } from './khalti-client';

export interface KhaltiPaymentRequest {
  readonly pidx: string;
  readonly paymentUrl: string;
  readonly expiresAt: string | null;
}

export interface KhaltiLookupResult {
  /** Khalti status: Completed, Pending, Initiated, Expired, User canceled, Refunded, ... */
  readonly status: string;
  /** Present only for Completed: the escrow credit / order placement outcome. */
  readonly payment: ConfirmedPayment | null;
}

/**
 * Khalti ePay v2 web checkout (SPEC: Nepal localizations §2). Only Khalti's own server-side
 * lookup is trusted. The app merely forwards the pidx it received on return_url.
 */
export class KhaltiService {
  constructor(
    private readonly db: Database,
    private readonly checkout: CheckoutService,
    private readonly confirmation: PaymentConfirmationService,
    private readonly client: KhaltiClient,
    private readonly gatewayAccounts: VendorGatewayAccountService,
  ) {}

  /** A Model C order is paid into the shop's own Khalti account, with its own secret. */
  private async secretFor(order: {
    readonly vendor_id: string;
    readonly settlement_model_locked: string;
  }): Promise<string | undefined> {
    if (order.settlement_model_locked !== 'DIRECT_PREPAID') return undefined;
    return (await this.gatewayAccounts.credentialsFor(order.vendor_id, 'KHALTI')).secret;
  }

  async initiate(customerId: string, orderId: string): Promise<KhaltiPaymentRequest> {
    const { order, lock } = await this.checkout.getOrderLockStatus(customerId, orderId);
    assertPayable(order, lock, 'KHALTI');

    const response = await this.client.initiate(
      {
        amountPaisa: orderTotalPaisa(order),
        purchaseOrderId: order.id,
        purchaseOrderName: `Hamro Pasal order ${order.id.slice(0, 8)}`,
      },
      await this.secretFor(order),
    );
    await this.db
      .update(orders)
      .set({ payment_gateway_ref: response.pidx })
      .where(and(eq(orders.id, order.id), eq(orders.payment_status, 'PENDING')));

    return {
      pidx: response.pidx,
      paymentUrl: response.payment_url,
      expiresAt: response.expires_at ?? null,
    };
  }

  /** POST /api/payments/khalti/lookup: verify with Khalti, credit escrow only when Completed. */
  async lookup(customerId: string, pidx: string): Promise<KhaltiLookupResult> {
    const [order] = await this.db
      .select({
        id: orders.id,
        vendor_id: orders.vendor_id,
        settlement_model_locked: orders.settlement_model_locked,
      })
      .from(orders)
      .where(
        and(
          eq(orders.payment_method, 'KHALTI'),
          eq(orders.payment_gateway_ref, pidx),
          eq(orders.customer_id, customerId),
        ),
      );
    if (order === undefined) {
      throw new PaymentNotFoundError('KHALTI', pidx);
    }

    const result = await this.client.lookup(pidx, await this.secretFor(order));
    if (result.pidx !== pidx) {
      throw new PaymentGatewayError('KHALTI', 'lookup returned a different pidx');
    }
    if (result.status !== KHALTI_COMPLETED) {
      return { status: result.status, payment: null };
    }
    const payment = await this.confirmation.confirm({
      gateway: 'KHALTI',
      gatewayRef: pidx,
      paidPaisa: result.total_amount,
    });
    return { status: result.status, payment };
  }
}

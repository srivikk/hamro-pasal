import { randomUUID } from 'node:crypto';

import { orders, type Database } from '@hamro-pasal/db';
import { and, eq, isNull } from 'drizzle-orm';

import { OrderNotFoundError } from '../checkout/checkout-service';
import { CheckoutRejectedError } from '../checkout/pricing';
import type { EsewaConfig, EsewaService } from './esewa/esewa-service';
import { esewaHmacBase64, esewaSignatureMessage } from './esewa/signature';
import type { Gateway } from './gateway-http';
import { KHALTI_COMPLETED } from './khalti/khalti-client';
import { formatNpr } from './payable-order';
import {
  orderTotalPaisa,
  type ConfirmedPayment,
  type PaymentConfirmationService,
} from './payment-confirmation';

/** The fields eSewa signs on its success redirect, in its order. */
const MOCK_CALLBACK_SIGNED_FIELDS = [
  'transaction_code',
  'status',
  'total_amount',
  'transaction_uuid',
  'product_code',
  'signed_field_names',
] as const;

export interface MockPaymentResult {
  readonly gateway: Gateway;
  /** The gateway's own success status: COMPLETE (eSewa) or Completed (Khalti). */
  readonly status: string;
  readonly payment: ConfirmedPayment;
}

/**
 * Local end-to-end runs only (MOCK_SERVICES, never in production): pays a prepaid order without
 * eSewa or Khalti. Nothing about the confirmation itself is faked. An eSewa order goes through the
 * real webhook handler with a callback signed by the configured merchant secret; a Khalti order
 * skips only Khalti's server-side lookup (a network call) and enters the same confirmation the
 * lookup ends in. So the amount check, the escrow credit, the lock claim and PLACED are the real ones.
 */
export class MockPaymentService {
  constructor(
    private readonly db: Database,
    private readonly esewa: EsewaService,
    private readonly confirmation: PaymentConfirmationService,
    private readonly esewaConfig: Pick<EsewaConfig, 'productCode' | 'secretKey'>,
  ) {}

  async pay(orderId: string): Promise<MockPaymentResult> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId));
    if (order === undefined) throw new OrderNotFoundError(orderId);
    if (order.payment_method === 'COD') {
      throw new CheckoutRejectedError(
        'WRONG_PAYMENT_METHOD',
        'A COD order is paid at the door, not through a gateway',
        undefined,
        409,
      );
    }
    const gateway = order.payment_method;
    const gatewayRef =
      order.payment_gateway_ref ?? (await this.assignGatewayRef(order.id, gateway));
    const paidPaisa = orderTotalPaisa(order);

    if (gateway === 'KHALTI') {
      const payment = await this.confirmation.confirm({ gateway, gatewayRef, paidPaisa });
      return { gateway, status: KHALTI_COMPLETED, payment };
    }
    const { status, payment } = await this.esewa.handleCallback(
      this.signedEsewaCallback(gatewayRef, formatNpr(paidPaisa)),
    );
    if (payment === null) throw new Error(`Mock eSewa callback ended as ${status}`);
    return { gateway, status, payment };
  }

  /** The reference `initiate` would have stored, for an order whose payment was never started. */
  private async assignGatewayRef(orderId: string, gateway: Gateway): Promise<string> {
    const candidate = gateway === 'ESEWA' ? randomUUID() : `mock-pidx-${randomUUID()}`;
    await this.db
      .update(orders)
      .set({ payment_gateway_ref: candidate })
      .where(and(eq(orders.id, orderId), isNull(orders.payment_gateway_ref)));
    // Re-read: a concurrent initiate (or mock payment) may have stored its own first.
    const [current] = await this.db
      .select({ ref: orders.payment_gateway_ref })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (current?.ref == null) throw new OrderNotFoundError(orderId);
    return current.ref;
  }

  /** The base64 `data` of eSewa's success redirect, signed as eSewa signs it. */
  private signedEsewaCallback(transactionUuid: string, totalAmount: string): string {
    const fields: Record<string, string> = {
      transaction_code: `MOCK${randomUUID().slice(0, 8).toUpperCase()}`,
      status: 'COMPLETE',
      total_amount: totalAmount,
      transaction_uuid: transactionUuid,
      product_code: this.esewaConfig.productCode,
      signed_field_names: MOCK_CALLBACK_SIGNED_FIELDS.join(','),
    };
    const signature = esewaHmacBase64(
      esewaSignatureMessage(fields, MOCK_CALLBACK_SIGNED_FIELDS),
      this.esewaConfig.secretKey,
    );
    return Buffer.from(JSON.stringify({ ...fields, signature }), 'utf8').toString('base64');
  }
}

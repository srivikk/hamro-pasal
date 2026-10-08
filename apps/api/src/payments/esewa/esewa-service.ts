import { randomUUID } from 'node:crypto';

import { orders, type Database } from '@hamro-pasal/db';
import { and, eq } from 'drizzle-orm';

import type { CheckoutService } from '../../checkout/checkout-service';
import { toPaisa } from '../../ledger/money';
import { assertPayable, formatNpr } from '../payable-order';
import {
  orderTotalPaisa,
  type ConfirmedPayment,
  type PaymentConfirmationService,
} from '../payment-confirmation';
import {
  decodeEsewaCallback,
  ESEWA_REQUEST_SIGNED_FIELDS,
  signEsewaRequest,
  verifyEsewaCallbackSignature,
} from './signature';

export interface EsewaConfig {
  readonly productCode: string;
  readonly secretKey: string;
  /** ePay v2 form endpoint, e.g. https://rc-epay.esewa.com.np/api/epay/main/v2/form */
  readonly paymentUrl: string;
  readonly successUrl: string;
  readonly failureUrl: string;
}

/** The callback could not be authenticated or is malformed. Nothing was credited. */
export class InvalidGatewayCallbackError extends Error {
  constructor(reason: string) {
    super(`Invalid payment callback: ${reason}`);
    this.name = 'InvalidGatewayCallbackError';
  }
}

export interface EsewaPaymentRequest {
  readonly paymentUrl: string;
  /** Posted by the app's WebView as an HTML form to `paymentUrl`. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface EsewaCallbackResult {
  /** eSewa status: COMPLETE, PENDING, CANCELED, NOT_FOUND, FULL_REFUND, ... */
  readonly status: string;
  /** Present only for COMPLETE: the escrow credit / order placement outcome. */
  readonly payment: ConfirmedPayment | null;
}

/**
 * eSewa ePay v2 (SPEC: Nepal localizations §1). The app loads the signed form in a WebView (or
 * the eSewa app via deep link), and eSewa redirects to success_url with a base64 `data` param,
 * which the app forwards to POST /api/payments/esewa/webhook. That payload is authenticated
 * solely by the merchant-secret HMAC, so no user token is required on the webhook.
 */
export class EsewaService {
  constructor(
    private readonly db: Database,
    private readonly checkout: CheckoutService,
    private readonly confirmation: PaymentConfirmationService,
    private readonly config: EsewaConfig,
  ) {}

  async initiate(customerId: string, orderId: string): Promise<EsewaPaymentRequest> {
    const { order, lock } = await this.checkout.getOrderLockStatus(customerId, orderId);
    assertPayable(order, lock, 'ESEWA');

    // A fresh transaction_uuid per attempt (eSewa rejects reused ids). It is stored as the
    // order's gateway reference, which the callback is matched on.
    const transactionUuid = randomUUID();
    await this.db
      .update(orders)
      .set({ payment_gateway_ref: transactionUuid })
      .where(and(eq(orders.id, order.id), eq(orders.payment_status, 'PENDING')));

    const totalAmount = formatNpr(orderTotalPaisa(order));
    const signed = {
      total_amount: totalAmount,
      transaction_uuid: transactionUuid,
      product_code: this.config.productCode,
    };
    return {
      paymentUrl: this.config.paymentUrl,
      fields: {
        // eSewa checks total_amount = amount + tax + service charge + delivery charge.
        amount: formatNpr(orderTotalPaisa(order) - toPaisa(order.delivery_fee)),
        tax_amount: '0',
        product_service_charge: '0',
        product_delivery_charge: formatNpr(toPaisa(order.delivery_fee)),
        ...signed,
        success_url: this.config.successUrl,
        failure_url: this.config.failureUrl,
        signed_field_names: ESEWA_REQUEST_SIGNED_FIELDS.join(','),
        signature: signEsewaRequest(signed, this.config.secretKey),
      },
    };
  }

  /**
   * POST /api/payments/esewa/webhook. Verifies the HMAC signature and product code, requires
   * status COMPLETE, then (under an order row lock) checks the amount within 0.01 NPR and
   * credits escrow exactly once.
   */
  async handleCallback(data: string): Promise<EsewaCallbackResult> {
    let fields: Readonly<Record<string, string>>;
    try {
      fields = decodeEsewaCallback(data);
    } catch {
      throw new InvalidGatewayCallbackError('data is not base64-encoded JSON');
    }
    if (!verifyEsewaCallbackSignature(fields, this.config.secretKey)) {
      throw new InvalidGatewayCallbackError('signature mismatch');
    }
    const { status, transaction_uuid: transactionUuid, product_code: productCode } = fields;
    if (productCode !== this.config.productCode) {
      throw new InvalidGatewayCallbackError('unexpected product_code');
    }
    if (status === undefined || transactionUuid === undefined) {
      throw new InvalidGatewayCallbackError('missing status or transaction_uuid');
    }
    if (status !== 'COMPLETE') {
      return { status, payment: null };
    }

    const paid = Number((fields.total_amount ?? '').replaceAll(',', ''));
    if (!Number.isFinite(paid) || paid <= 0) {
      throw new InvalidGatewayCallbackError('total_amount is not a positive number');
    }
    const payment = await this.confirmation.confirm({
      gateway: 'ESEWA',
      gatewayRef: transactionUuid,
      paidPaisa: Math.round(paid * 100),
    });
    return { status, payment };
  }
}

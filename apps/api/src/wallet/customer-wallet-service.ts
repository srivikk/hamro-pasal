import { randomUUID } from 'node:crypto';

import {
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  vendors,
  walletRecharges,
  type Database,
} from '@hamro-pasal/db';
import type { LedgerService, PlannedPosting } from '@hamro-pasal/ledger';
import {
  MAX_CUSTOMER_WALLET_BALANCE_NPR,
  type CustomerWalletView,
  type WalletEntryKind,
  type WalletRechargeRequest,
  type WalletRechargeView,
} from '@hamro-pasal/shared-types';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { HttpError } from '../http/http-error';
import { toPaisa } from '../ledger/money';
import { InvalidGatewayCallbackError, type EsewaConfig } from '../payments/esewa/esewa-service';
import {
  decodeEsewaCallback,
  ESEWA_REQUEST_SIGNED_FIELDS,
  signEsewaRequest,
  verifyEsewaCallbackSignature,
} from '../payments/esewa/signature';
import { formatNpr } from '../payments/payable-order';
import { AMOUNT_TOLERANCE_PAISA } from '../payments/payment-confirmation';

type RechargeRow = typeof walletRecharges.$inferSelect;

const ENTRY_PAGE = 50;

/**
 * Whose balance a recharge funds: a customer's stored-value wallet (SPEC core 12), or a shop's
 * ledger (SPEC core 5: a Model C prepaid balance up to its reserve, or any shop's dues). The shop is
 * always the signed-in vendor's own; nothing in a request names one.
 */
export type RechargeTarget =
  | { readonly kind: 'CUSTOMER'; readonly userId: string }
  | { readonly kind: 'VENDOR'; readonly userId: string };

export function rechargeView(row: RechargeRow): WalletRechargeView {
  if (row.gateway !== 'ESEWA' && row.gateway !== 'KHALTI') {
    throw new Error(`A recharge through ${row.gateway}`);
  }
  return {
    id: row.id,
    gateway: row.gateway,
    amount_npr: row.amount_npr,
    status: row.status,
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
  };
}

/** The wallet would hold more than MAX_CUSTOMER_WALLET_BALANCE_NPR after the recharge. */
export class WalletBalanceLimitError extends HttpError {
  constructor(balanceNpr: number) {
    super(422, 'WALLET_BALANCE_LIMIT', 'Your wallet cannot hold that much', {
      balance_npr: balanceNpr,
      max_balance_npr: MAX_CUSTOMER_WALLET_BALANCE_NPR,
    });
  }
}

export interface RechargeInitiated {
  readonly recharge: WalletRechargeView;
  readonly paymentUrl: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly replayed: boolean;
}

export interface RechargeConfirmed {
  readonly status: string;
  readonly recharge: WalletRechargeView;
  readonly balanceNpr: number;
  readonly credited: boolean;
}

/**
 * Stored value and recharges (2026-10-21). A customer's balance is its CUSTOMER_WALLET ledger
 * account (opened by the first recharge, never negative: a CHECK); a shop's is its VENDOR_WALLET.
 * Money enters only through a gateway recharge into the platform's own eSewa merchant account
 * (GATEWAY_CLEARING to the wallet, one journal, under the recharge row lock). A customer's leaves
 * only to pay an order (routed like a gateway payment, CheckoutService) and comes back with its
 * refund. A shop's recharge goes through LedgerService, so it lifts a debt suspension (or, for
 * Model C, a suspension below the reserve) in the same commit.
 */
export class CustomerWalletService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly esewa: EsewaConfig,
  ) {}

  /** GET /api/wallet. */
  async view(customerId: string): Promise<CustomerWalletView> {
    const [account] = await this.db
      .select({ id: ledgerAccounts.id, balance: ledgerAccounts.balance_npr })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.customer_user_id, customerId));
    if (account === undefined) {
      return { balance_npr: 0, max_balance_npr: MAX_CUSTOMER_WALLET_BALANCE_NPR, entries: [] };
    }
    const rows = await this.db
      .select({
        id: ledgerEntries.id,
        amount: ledgerEntries.amount_npr,
        kind: ledgerTransactions.kind,
        orderId: ledgerTransactions.order_id,
        createdAt: ledgerEntries.created_at,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transaction_id))
      .where(eq(ledgerEntries.account_id, account.id))
      .orderBy(desc(ledgerEntries.created_at), desc(ledgerEntries.id))
      .limit(ENTRY_PAGE);
    return {
      balance_npr: account.balance,
      max_balance_npr: MAX_CUSTOMER_WALLET_BALANCE_NPR,
      entries: rows.map((row) => ({
        id: row.id,
        kind: entryKindOf(row.kind, row.amount),
        amount_npr: row.amount,
        order_id: row.orderId,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * POST /api/wallet/recharge/esewa/initiate (a customer) or /api/vendors/wallet/recharge/esewa/
   * initiate (a shop): a PENDING recharge and the signed eSewa form for it. One key per attempt: a
   * retry returns the same recharge, signed again with a fresh transaction id (eSewa refuses a
   * reused one).
   */
  async initiateEsewa(
    target: RechargeTarget,
    request: WalletRechargeRequest,
  ): Promise<RechargeInitiated> {
    const vendorId = await this.vendorIdOf(target);
    const [existing] = await this.db
      .select()
      .from(walletRecharges)
      .where(
        and(
          eq(walletRecharges.user_id, target.userId),
          eq(walletRecharges.idempotency_key, request.idempotency_key),
        ),
      );
    if (existing !== undefined) {
      if (
        toPaisa(existing.amount_npr) !== toPaisa(request.amount_npr) ||
        existing.vendor_id !== vendorId
      ) {
        throw new HttpError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'This key was used for another recharge',
        );
      }
      if (existing.status !== 'PENDING') {
        return { ...this.signed(existing, existing.gateway_ref), replayed: true };
      }
      const gatewayRef = randomUUID();
      const [renewed] = await this.db
        .update(walletRecharges)
        .set({ gateway_ref: gatewayRef })
        .where(and(eq(walletRecharges.id, existing.id), eq(walletRecharges.status, 'PENDING')))
        .returning();
      return { ...this.signed(renewed ?? existing, gatewayRef), replayed: true };
    }

    if (target.kind === 'CUSTOMER') {
      const balance = (await this.view(target.userId)).balance_npr;
      if (
        toPaisa(balance) + toPaisa(request.amount_npr) >
        toPaisa(MAX_CUSTOMER_WALLET_BALANCE_NPR)
      ) {
        throw new WalletBalanceLimitError(balance);
      }
    }
    const gatewayRef = randomUUID();
    const [created] = await this.db
      .insert(walletRecharges)
      .values({
        user_id: target.userId,
        vendor_id: vendorId,
        gateway: 'ESEWA',
        amount_npr: request.amount_npr,
        idempotency_key: request.idempotency_key,
        gateway_ref: gatewayRef,
      })
      .onConflictDoNothing({ target: [walletRecharges.user_id, walletRecharges.idempotency_key] })
      .returning();
    // Lost a race with the same key: answer as the replay it is.
    if (created === undefined) return this.initiateEsewa(target, request);
    return { ...this.signed(created, gatewayRef), replayed: false };
  }

  /**
   * POST …/recharge/esewa/confirm: eSewa's redirect `data`, verified by the platform's merchant
   * HMAC. COMPLETE with the recharge's amount (within 0.01 NPR) credits the wallet once, under the
   * recharge row lock; any other status changes nothing.
   */
  async confirmEsewa(target: RechargeTarget, data: string): Promise<RechargeConfirmed> {
    const vendorId = await this.vendorIdOf(target);
    let fields: Readonly<Record<string, string>>;
    try {
      fields = decodeEsewaCallback(data);
    } catch {
      throw new InvalidGatewayCallbackError('data is not base64-encoded JSON');
    }
    if (!verifyEsewaCallbackSignature(fields, this.esewa.secretKey)) {
      throw new InvalidGatewayCallbackError('signature mismatch');
    }
    const { status, transaction_uuid: transactionUuid, product_code: productCode } = fields;
    if (productCode !== this.esewa.productCode) {
      throw new InvalidGatewayCallbackError('unexpected product_code');
    }
    if (status === undefined || transactionUuid === undefined) {
      throw new InvalidGatewayCallbackError('missing status or transaction_uuid');
    }

    const outcome = await this.db.transaction(async (tx) => {
      const [recharge] = await tx
        .select()
        .from(walletRecharges)
        .where(
          and(
            eq(walletRecharges.gateway, 'ESEWA'),
            eq(walletRecharges.gateway_ref, transactionUuid),
            eq(walletRecharges.user_id, target.userId),
            vendorId === null
              ? isNull(walletRecharges.vendor_id)
              : eq(walletRecharges.vendor_id, vendorId),
          ),
        )
        .for('update');
      if (recharge === undefined) {
        throw new HttpError(404, 'RECHARGE_NOT_FOUND', 'No such recharge');
      }
      if (status !== 'COMPLETE' || recharge.status !== 'PENDING') {
        return { recharge, credited: false };
      }
      const paid = Number((fields.total_amount ?? '').replaceAll(',', ''));
      const expected = toPaisa(recharge.amount_npr);
      if (
        !Number.isFinite(paid) ||
        Math.abs(Math.round(paid * 100) - expected) > AMOUNT_TOLERANCE_PAISA
      ) {
        throw new HttpError(409, 'PAYMENT_AMOUNT_MISMATCH', 'The paid amount does not match');
      }
      const credit: PlannedPosting =
        vendorId === null
          ? {
              account: { type: 'CUSTOMER_WALLET', customerUserId: target.userId },
              amountPaisa: expected,
              lineType: 'RECHARGE',
            }
          : {
              account: { type: 'VENDOR_WALLET', vendorId },
              amountPaisa: expected,
              lineType: 'RECHARGE',
            };
      const posted = await this.ledger.post(tx, {
        kind: vendorId === null ? 'CUSTOMER_WALLET_RECHARGE' : 'VENDOR_TOP_UP',
        idempotencyKey: `wallet-recharge:${recharge.id}`,
        orderId: null,
        description: 'Recharged through eSewa',
        postings: [
          { account: { type: 'GATEWAY_CLEARING', gateway: 'ESEWA' }, amountPaisa: -expected },
          credit,
        ],
      });
      const [completed] = await tx
        .update(walletRecharges)
        .set({
          status: 'COMPLETED',
          transaction_id: posted.transactionId,
          completed_at: new Date(),
        })
        .where(eq(walletRecharges.id, recharge.id))
        .returning();
      if (completed === undefined) throw new Error('The recharge vanished');
      return { recharge: completed, credited: true };
    });
    return {
      status,
      recharge: rechargeView(outcome.recharge),
      balanceNpr: await this.balanceOf(target, vendorId),
      credited: outcome.credited,
    };
  }

  private async balanceOf(target: RechargeTarget, vendorId: string | null): Promise<number> {
    if (vendorId === null) return (await this.view(target.userId)).balance_npr;
    const [shop] = await this.db
      .select({ balance: vendors.wallet_balance_npr })
      .from(vendors)
      .where(eq(vendors.id, vendorId));
    return shop?.balance ?? 0;
  }

  /** The signed-in vendor's own shop, or null for a customer. */
  private async vendorIdOf(target: RechargeTarget): Promise<string | null> {
    if (target.kind === 'CUSTOMER') return null;
    const [shop] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, target.userId));
    if (shop === undefined)
      throw new HttpError(404, 'VENDOR_NOT_FOUND', 'No shop for this account');
    return shop.id;
  }

  private signed(recharge: RechargeRow, gatewayRef: string): Omit<RechargeInitiated, 'replayed'> {
    const signedFields = {
      total_amount: formatNpr(toPaisa(recharge.amount_npr)),
      transaction_uuid: gatewayRef,
      product_code: this.esewa.productCode,
    };
    return {
      recharge: rechargeView(recharge),
      paymentUrl: this.esewa.paymentUrl,
      fields: {
        amount: signedFields.total_amount,
        tax_amount: '0',
        product_service_charge: '0',
        product_delivery_charge: '0',
        ...signedFields,
        success_url: this.esewa.successUrl,
        failure_url: this.esewa.failureUrl,
        signed_field_names: ESEWA_REQUEST_SIGNED_FIELDS.join(','),
        signature: signEsewaRequest(signedFields, this.esewa.secretKey),
      },
    };
  }
}

function entryKindOf(
  kind: (typeof ledgerTransactions.$inferSelect)['kind'],
  amountNpr: number,
): WalletEntryKind {
  if (kind === 'CUSTOMER_WALLET_RECHARGE') return 'RECHARGE';
  return amountNpr < 0 ? 'PAYMENT' : 'REFUND';
}

import { ledgerAccounts, ledgerEntries, vendors, type Database } from '@hamro-pasal/db';
import type { VendorStatus, WalletTopUpMode, WalletTopUpRequest } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import type { LedgerService } from '../ledger/ledger-service';
import { toPaisa } from '../ledger/money';
import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

/** WALLET_TOP_UP_MODE=DISABLED: no top-up flow is available on this server. */
export class TopUpUnavailableError extends Error {
  constructor() {
    super('Wallet top-ups are not available');
    this.name = 'TopUpUnavailableError';
  }
}

/** The idempotency key was already used for a top-up of a different amount. */
export class TopUpKeyReusedError extends Error {
  constructor() {
    super('This idempotency key belongs to another top-up');
    this.name = 'TopUpKeyReusedError';
  }
}

export interface TopUpResult {
  readonly transactionId: string;
  readonly amountNpr: number;
  readonly walletBalanceNpr: number;
  readonly status: VendorStatus;
  /** This top-up lifted a debt suspension. */
  readonly restored: boolean;
  readonly replayed: boolean;
}

/**
 * POST /api/vendors/wallet/top-up (SPEC §5: a vendor clears a negative wallet with an upfront
 * payment). There is no eSewa top-up flow yet, so in MOCK mode (refused in production by
 * parseServerEnv) the credit is posted without taking any payment: a balanced VENDOR_TOP_UP journal
 * GATEWAY_CLEARING(ESEWA) → VENDOR_WALLET, the same shape a real eSewa capture will have. The
 * journal goes through LedgerService, so WalletService restores a debt-suspended vendor in the same
 * transaction and writes `vendor.restored`.
 */
export class VendorTopUpService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly mode: WalletTopUpMode,
  ) {}

  topUp(vendorUserId: string, request: WalletTopUpRequest): Promise<TopUpResult> {
    if (this.mode === 'DISABLED') return Promise.reject(new TopUpUnavailableError());
    const amountPaisa = toPaisa(request.amount_npr);

    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.user_id, vendorUserId));
      if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);

      const posted = await this.ledger.post(tx, {
        kind: 'VENDOR_TOP_UP',
        // Scoped to the vendor: two vendors can never collide on a client-generated key.
        idempotencyKey: `vendor-top-up:${vendor.id}:${request.idempotency_key}`,
        orderId: null,
        description: 'Mock top-up (no payment taken)',
        postings: [
          { account: { type: 'GATEWAY_CLEARING', gateway: 'ESEWA' }, amountPaisa: -amountPaisa },
          { account: { type: 'VENDOR_WALLET', vendorId: vendor.id }, amountPaisa },
        ],
      });

      if (posted.status === 'duplicate') {
        const [credit] = await tx
          .select({ amountNpr: ledgerEntries.amount_npr })
          .from(ledgerEntries)
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.account_id))
          .where(
            and(
              eq(ledgerEntries.transaction_id, posted.transactionId),
              eq(ledgerAccounts.vendor_id, vendor.id),
            ),
          );
        if (credit === undefined || toPaisa(credit.amountNpr) !== amountPaisa) {
          throw new TopUpKeyReusedError();
        }
      }

      const [after] = await tx
        .select({ status: vendors.status, walletBalanceNpr: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendor.id));
      if (after === undefined) throw new VendorAccountNotFoundError(vendorUserId);

      return {
        transactionId: posted.transactionId,
        amountNpr: request.amount_npr,
        walletBalanceNpr: after.walletBalanceNpr,
        status: after.status,
        restored:
          posted.status === 'posted' &&
          posted.standingChanges.some((c) => c.type === 'RESTORED' && c.vendorId === vendor.id),
        replayed: posted.status === 'duplicate',
      };
    });
  }
}

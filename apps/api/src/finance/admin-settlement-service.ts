import {
  payoutRequests,
  recordAuditLog,
  vendorBankAccounts,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { toNpr, toPaisa, type LedgerService } from '@hamro-pasal/ledger';
import {
  ADMIN_VENDOR_LIST_LIMIT,
  maskAccountNumber,
  NO_AUDIT_CONTEXT,
  type AuditContext,
  type SettlementModel,
  type SettlementPayoutRequest,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';

import { adFeesDueByVendor, adFeesDuePaisa, collectAdFeesDue } from '../marketing/ad-fees';
import { disputeHoldByVendor, pendingEscrowByVendor } from '../wallet/vendor-wallet-service';
import { AdminVendorNotFoundError } from '../wallet/wallet-service';
import {
  PayoutExceedsBalanceError,
  PayoutKeyReusedError,
  type PayoutRow,
} from './vendor-finance-service';

type VendorRow = typeof vendors.$inferSelect;
export type PrimaryBankAccount = typeof vendorBankAccounts.$inferSelect;

/** A shop and what the platform holds for it. */
export interface SettlementVendor {
  readonly vendor: Pick<
    VendorRow,
    | 'id'
    | 'business_name'
    | 'phone'
    | 'wallet_balance_npr'
    | 'tax_id'
    | 'pan_verified_at'
    | 'settlement_model'
  >;
  /** What may leave the platform now: the wallet balance less ad fees still due, never below 0. */
  readonly availableForPayoutNpr: number;
  readonly pendingEscrowNpr: number;
  /** Step 7.3: delivered prepaid earnings in the dispute hold. Not payable. */
  readonly disputeHoldNpr: number;
  /** Where the payout is sent; null holds every payout. */
  readonly primaryBankAccount: PrimaryBankAccount | null;
}

export interface SettlementPayoutResult {
  readonly payout: PayoutRow;
  readonly vendor: SettlementVendor;
  readonly replayed: boolean;
}

/** The PAN payout gate (SPEC core 5): no transfer while the vendor's PAN document is unverified. */
export class PanNotVerifiedError extends Error {
  constructor(readonly vendorId: string) {
    super('Cannot disburse funds: PAN not verified.');
    this.name = 'PanNotVerifiedError';
  }
}

/** The final gate: a payout needs somewhere to go, the vendor's primary bank account. */
export class BankAccountMissingError extends Error {
  constructor(readonly vendorId: string) {
    super('Cannot disburse funds: the vendor has no primary bank account on file.');
    this.name = 'BankAccountMissingError';
  }
}

/** Only Model B (PLATFORM_ESCROW) money is held by the platform and paid out by it. */
export class SettlementModelNotEscrowError extends Error {
  constructor(
    readonly vendorId: string,
    readonly settlementModel: SettlementModel,
  ) {
    super(`The platform holds no payout for a ${settlementModel} vendor`);
    this.name = 'SettlementModelNotEscrowError';
  }
}

const vendorColumns = {
  id: vendors.id,
  business_name: vendors.business_name,
  phone: vendors.phone,
  wallet_balance_npr: vendors.wallet_balance_npr,
  tax_id: vendors.tax_id,
  pan_verified_at: vendors.pan_verified_at,
  settlement_model: vendors.settlement_model,
};

/** SPEC core 8, Model B: an ad's flat fee is deducted from the vendor's payouts. */
function availableOf(walletBalanceNpr: number, adFeesDuePaisa = 0): number {
  return Math.max(0, toNpr(toPaisa(walletBalanceNpr) - adFeesDuePaisa));
}

/**
 * Settlements (SPEC core 5, "Payouts"): the platform pays a Model B vendor what it holds for it.
 * A Super Admin initiates the payout here; a vendor never requests one.
 *
 * Only Model B (`PLATFORM_ESCROW`) vendors are listed and paid: the platform holds no money for
 * the other models.
 *
 * The money was moved from SYSTEM_ESCROW into the vendor's wallet when each order was delivered.
 * A payout moves it out of the wallet (VENDOR_WALLET -> PAYOUT_CLEARING, the Phase 22
 * `VENDOR_PAYOUT` journal) and is recorded as an APPROVED row of `payout_requests`, the record of
 * every payout, with the bank transfer's reference. There is no balance table.
 */
export class AdminSettlementService {
  constructor(
    private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  /** One snapshot: the shops the platform owes money to now, by business name. */
  list(): Promise<SettlementVendor[]> {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select(vendorColumns)
          .from(vendors)
          .where(
            and(gt(vendors.wallet_balance_npr, 0), eq(vendors.settlement_model, 'PLATFORM_ESCROW')),
          )
          .orderBy(asc(vendors.business_name), asc(vendors.id))
          .limit(ADMIN_VENDOR_LIST_LIMIT);
        const ids = rows.map((row) => row.id);
        const escrow = await pendingEscrowByVendor(tx, ids);
        const hold = await disputeHoldByVendor(tx, ids);
        const feesDue = await adFeesDueByVendor(tx, ids);
        const accounts =
          ids.length === 0
            ? []
            : await tx
                .select()
                .from(vendorBankAccounts)
                .where(
                  and(
                    inArray(vendorBankAccounts.vendor_id, ids),
                    eq(vendorBankAccounts.is_primary, true),
                  ),
                );
        const primary = new Map(accounts.map((account) => [account.vendor_id, account]));
        return rows.map((vendor) => ({
          vendor,
          availableForPayoutNpr: availableOf(vendor.wallet_balance_npr, feesDue.get(vendor.id)),
          pendingEscrowNpr: escrow.get(vendor.id) ?? 0,
          disputeHoldNpr: hold.get(vendor.id) ?? 0,
          primaryBankAccount: primary.get(vendor.id) ?? null,
        }));
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * One transaction under the vendor row lock (the lock a PAN change, a PAN verification and
   * every wallet journal take), so the gate and the balance are read at the moment of the
   * transfer: a payout never goes out on a verification that was cleared first, and concurrent
   * payouts never exceed the balance.
   */
  payout(
    adminUserId: string,
    vendorId: string,
    request: SettlementPayoutRequest,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<SettlementPayoutResult> {
    const amountPaisa = toPaisa(request.amount_npr);
    const storedKey = settlementPayoutKey(request.idempotency_key);

    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select(vendorColumns)
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (vendor === undefined) throw new AdminVendorNotFoundError(vendorId);

      // A retried request moves no money: it answers with the payout it already made.
      const [existing] = await tx
        .select()
        .from(payoutRequests)
        .where(
          and(
            eq(payoutRequests.vendor_id, vendorId),
            eq(payoutRequests.idempotency_key, storedKey),
          ),
        );
      if (existing !== undefined) {
        if (
          toPaisa(existing.amount_npr) !== amountPaisa ||
          existing.bank_reference !== request.bank_reference
        ) {
          throw new PayoutKeyReusedError();
        }
        return { payout: existing, vendor: await settlementVendor(tx, vendor), replayed: true };
      }

      if (vendor.settlement_model !== 'PLATFORM_ESCROW') {
        throw new SettlementModelNotEscrowError(vendorId, vendor.settlement_model);
      }
      // The gates, before anything is posted: a verified PAN, then somewhere to send the money.
      if (vendor.pan_verified_at === null) throw new PanNotVerifiedError(vendorId);
      const bankAccount = await primaryBankAccountOf(tx, vendorId);
      if (bankAccount === null) throw new BankAccountMissingError(vendorId);

      // Ad fees the shop owes are taken out of the wallet first (AD_REVENUE, their own journal):
      // what is paid out is what is left.
      const adFeesCollectedPaisa = await collectAdFeesDue(tx, this.ledger, vendorId);
      const [swept] = await tx
        .select({ balance: vendors.wallet_balance_npr })
        .from(vendors)
        .where(eq(vendors.id, vendorId));
      const availableNpr = availableOf(
        swept?.balance ?? vendor.wallet_balance_npr,
        await adFeesDuePaisa(tx, vendorId),
      );
      if (amountPaisa > toPaisa(availableNpr)) {
        throw new PayoutExceedsBalanceError(request.amount_npr, availableNpr);
      }

      const journal = await this.ledger.post(tx, {
        kind: 'VENDOR_PAYOUT',
        idempotencyKey: `settlement-payout:${vendorId}:${request.idempotency_key}`,
        orderId: null,
        description: 'Settlement payout: paid to the vendor by bank transfer',
        postings: [
          { account: { type: 'VENDOR_WALLET', vendorId }, amountPaisa: -amountPaisa },
          { account: { type: 'PAYOUT_CLEARING' }, amountPaisa },
        ],
      });
      const [payout] = await tx
        .insert(payoutRequests)
        .values({
          vendor_id: vendorId,
          amount_npr: request.amount_npr,
          status: 'APPROVED',
          idempotency_key: storedKey,
          hold_transaction_id: journal.transactionId,
          bank_reference: request.bank_reference,
          decided_by_user_id: adminUserId,
          decided_at: new Date(),
        })
        .returning();
      if (payout === undefined) throw new Error('The payout was not stored');

      const [after] = await tx.select(vendorColumns).from(vendors).where(eq(vendors.id, vendorId));
      if (after === undefined) throw new Error(`Vendor ${vendorId} vanished`);

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'PAYOUT_PROCESSED',
        entityId: vendorId,
        vendorId,
        beforeState: {
          wallet_balance_npr: vendor.wallet_balance_npr,
          pan_verified_at: vendor.pan_verified_at.toISOString(),
        },
        afterState: {
          wallet_balance_npr: after.wallet_balance_npr,
          pan_verified_at: vendor.pan_verified_at.toISOString(),
          ...(adFeesCollectedPaisa > 0
            ? { ad_fees_collected_npr: toNpr(adFeesCollectedPaisa) }
            : {}),
          payout: {
            id: payout.id,
            amount_npr: toNpr(amountPaisa),
            bank_reference: request.bank_reference,
            ledger_transaction_id: journal.transactionId,
            // Where the money was sent, as the account stood at that moment.
            bank_account: {
              id: bankAccount.id,
              bank_name: bankAccount.bank_name,
              account_name: bankAccount.account_name,
              account_number_masked: maskAccountNumber(bankAccount.account_number),
            },
          },
        },
        context,
      });
      return { payout, vendor: await settlementVendor(tx, after), replayed: false };
    });
  }
}

/**
 * `payout_requests` keys are unique per vendor, and vendors' own (retiring) requests share the
 * table: the prefix keeps an admin's key from ever resolving to a vendor's request.
 */
export function settlementPayoutKey(idempotencyKey: string): string {
  return `admin-settlement:${idempotencyKey}`;
}

async function primaryBankAccountOf(
  tx: Transaction,
  vendorId: string,
): Promise<PrimaryBankAccount | null> {
  const [account] = await tx
    .select()
    .from(vendorBankAccounts)
    .where(
      and(eq(vendorBankAccounts.vendor_id, vendorId), eq(vendorBankAccounts.is_primary, true)),
    );
  return account ?? null;
}

async function settlementVendor(
  tx: Transaction,
  vendor: SettlementVendor['vendor'],
): Promise<SettlementVendor> {
  const escrow = await pendingEscrowByVendor(tx, [vendor.id]);
  const hold = await disputeHoldByVendor(tx, [vendor.id]);
  return {
    vendor,
    availableForPayoutNpr: availableOf(
      vendor.wallet_balance_npr,
      await adFeesDuePaisa(tx, vendor.id),
    ),
    pendingEscrowNpr: escrow.get(vendor.id) ?? 0,
    disputeHoldNpr: hold.get(vendor.id) ?? 0,
    primaryBankAccount: await primaryBankAccountOf(tx, vendor.id),
  };
}

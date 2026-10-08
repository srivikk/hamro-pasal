import {
  recordAuditLog,
  vendorBankAccounts,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import {
  MAX_VENDOR_BANK_ACCOUNTS,
  maskAccountNumber,
  type AuditActor,
  type AuditContext,
  type BankAccountWrite,
} from '@hamro-pasal/shared-types';
import { and, asc, desc, eq, ne } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

export type BankAccountRow = typeof vendorBankAccounts.$inferSelect;

type VendorActor = AuditActor & { kind: 'USER' };

export class BankAccountNotFoundError extends Error {
  constructor(readonly accountId: string) {
    super(`Bank account ${accountId} not found`);
    this.name = 'BankAccountNotFoundError';
  }
}

/** The shop already lists this account (same bank, same number). */
export class BankAccountExistsError extends Error {
  constructor() {
    super('This bank account is already on file');
    this.name = 'BankAccountExistsError';
  }
}

export class BankAccountLimitError extends Error {
  constructor(readonly max: number) {
    super(`A shop may hold at most ${String(max)} bank accounts`);
    this.name = 'BankAccountLimitError';
  }
}

/** The primary account cannot be un-marked directly: another account is made the primary instead. */
export class PrimaryBankAccountRequiredError extends Error {
  constructor() {
    super('A shop keeps one primary bank account: make another account the primary instead');
    this.name = 'PrimaryBankAccountRequiredError';
  }
}

/**
 * Where a shop's payouts are sent (SPEC core 5, "Payouts"). The shop is always the caller's own.
 *
 * - A shop with any account has **exactly one primary** account: the first account is primary
 *   whatever the request says, making another one primary takes it from the previous one in the
 *   same transaction, and the primary cannot be un-marked directly.
 * - Accounts are never deleted (a payout record must stay traceable to where it went).
 * - Every write runs in one transaction under the vendor row lock (the lock a settlement payout
 *   takes, so a payout always reads a settled primary account), with its audit entries. The
 *   account number is masked in every audit state.
 */
export class VendorBankAccountService {
  constructor(private readonly db: Database) {}

  /** The primary account first, then the oldest first. */
  async list(vendorUserId: string): Promise<BankAccountRow[]> {
    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
    return this.db
      .select()
      .from(vendorBankAccounts)
      .where(eq(vendorBankAccounts.vendor_id, vendor.id))
      .orderBy(
        desc(vendorBankAccounts.is_primary),
        asc(vendorBankAccounts.created_at),
        asc(vendorBankAccounts.id),
      );
  }

  create(
    actor: VendorActor,
    input: BankAccountWrite,
    context: AuditContext,
  ): Promise<BankAccountRow> {
    return this.db.transaction(async (tx) => {
      const vendorId = await lockVendor(tx, actor.user_id);
      const existing = await tx
        .select()
        .from(vendorBankAccounts)
        .where(eq(vendorBankAccounts.vendor_id, vendorId));
      if (existing.length >= MAX_VENDOR_BANK_ACCOUNTS) {
        throw new BankAccountLimitError(MAX_VENDOR_BANK_ACCOUNTS);
      }
      if (existing.some((account) => sameAccount(account, input))) {
        throw new BankAccountExistsError();
      }

      // The first account is where payouts go: a shop with accounts always has a primary one.
      const isPrimary = input.is_primary || existing.length === 0;
      if (isPrimary) await clearPrimary(tx, existing, actor, context);

      const [account] = await tx
        .insert(vendorBankAccounts)
        .values({ ...columnsOf(input), vendor_id: vendorId, is_primary: isPrimary })
        .returning();
      if (account === undefined) throw new Error('The bank account was not stored');

      await recordAuditLog(tx, {
        actor,
        action: 'BANK_ACCOUNT_ADDED',
        entityId: account.id,
        vendorId,
        beforeState: null,
        afterState: accountState(account),
        context,
      });
      return account;
    });
  }

  /** Replaces every field. Saving what is stored changes and records nothing. */
  update(
    actor: VendorActor,
    accountId: string,
    input: BankAccountWrite,
    context: AuditContext,
  ): Promise<BankAccountRow> {
    return this.db.transaction(async (tx) => {
      const vendorId = await lockVendor(tx, actor.user_id);
      const existing = await tx
        .select()
        .from(vendorBankAccounts)
        .where(eq(vendorBankAccounts.vendor_id, vendorId));
      // Another shop's account is not found: ids cannot be probed.
      const before = existing.find((account) => account.id === accountId);
      if (before === undefined) throw new BankAccountNotFoundError(accountId);
      if (before.is_primary && !input.is_primary) throw new PrimaryBankAccountRequiredError();
      const others = existing.filter((account) => account.id !== accountId);
      if (others.some((account) => sameAccount(account, input))) {
        throw new BankAccountExistsError();
      }

      const unchanged =
        before.bank_name === input.bank_name &&
        before.branch_name === input.branch_name &&
        before.account_name === input.account_name &&
        before.account_number === input.account_number &&
        before.routing_or_swift_code === input.routing_or_swift_code &&
        before.is_primary === input.is_primary;
      if (unchanged) return before;

      if (input.is_primary && !before.is_primary) await clearPrimary(tx, others, actor, context);
      const [after] = await tx
        .update(vendorBankAccounts)
        .set({ ...columnsOf(input), is_primary: input.is_primary })
        .where(
          and(eq(vendorBankAccounts.id, accountId), eq(vendorBankAccounts.vendor_id, vendorId)),
        )
        .returning();
      if (after === undefined) throw new BankAccountNotFoundError(accountId);

      await recordAuditLog(tx, {
        actor,
        action: 'BANK_ACCOUNT_UPDATED',
        entityId: accountId,
        vendorId,
        beforeState: accountState(before),
        afterState: accountState(after),
        context,
      });
      return after;
    });
  }
}

async function lockVendor(tx: Transaction, vendorUserId: string): Promise<string> {
  const [vendor] = await tx
    .select({ id: vendors.id })
    .from(vendors)
    .where(eq(vendors.user_id, vendorUserId))
    .for('update');
  if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);
  return vendor.id;
}

function sameAccount(account: BankAccountRow, input: BankAccountWrite): boolean {
  return account.bank_name === input.bank_name && account.account_number === input.account_number;
}

function columnsOf(input: BankAccountWrite) {
  return {
    bank_name: input.bank_name,
    branch_name: input.branch_name,
    account_name: input.account_name,
    account_number: input.account_number,
    routing_or_swift_code: input.routing_or_swift_code,
  };
}

/** Takes the primary mark from the account that has it, with that account's own audit entry. */
async function clearPrimary(
  tx: Transaction,
  accounts: readonly BankAccountRow[],
  actor: VendorActor,
  context: AuditContext,
): Promise<void> {
  const previous = accounts.find((account) => account.is_primary);
  if (previous === undefined) return;
  const [cleared] = await tx
    .update(vendorBankAccounts)
    .set({ is_primary: false })
    .where(and(eq(vendorBankAccounts.id, previous.id), ne(vendorBankAccounts.is_primary, false)))
    .returning();
  if (cleared === undefined) throw new Error(`Bank account ${previous.id} vanished`);
  await recordAuditLog(tx, {
    actor,
    action: 'BANK_ACCOUNT_UPDATED',
    entityId: previous.id,
    vendorId: previous.vendor_id,
    beforeState: accountState(previous),
    afterState: accountState(cleared),
    context,
  });
}

/** What the audit trail keeps of an account: everything but the number, which is masked. */
function accountState(account: BankAccountRow) {
  return {
    bank_name: account.bank_name,
    branch_name: account.branch_name,
    account_name: account.account_name,
    account_number_masked: maskAccountNumber(account.account_number),
    routing_or_swift_code: account.routing_or_swift_code,
    is_primary: account.is_primary,
  };
}

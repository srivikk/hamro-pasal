import {
  enqueueDomainEvent,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  users,
  type Transaction,
} from '@hamro-pasal/db';
import type { DomainEvent, LedgerAccount, LedgerTransactionKind } from '@hamro-pasal/shared-types';
import { eq, inArray } from 'drizzle-orm';

import { toNpr } from './money';
import type { AccountRef, PlannedPosting } from './settlement-plan';

export interface JournalInput {
  readonly kind: LedgerTransactionKind;
  /** Deterministic per business event, so a replay resolves to the original journal. */
  readonly idempotencyKey: string;
  readonly orderId: string | null;
  readonly description?: string;
  readonly postings: readonly PlannedPosting[];
}

export type PostResult =
  | { readonly status: 'posted'; readonly transactionId: string; readonly event: DomainEvent }
  | { readonly status: 'duplicate'; readonly transactionId: string };

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Posts balanced double-entry journals. Must run inside the caller's DB transaction, together
 * with the business state change it accounts for. The database independently enforces
 * balance (deferred trigger), append-only history, escrow >= 0 and the vendor wallet
 * floor/suspension (SPEC §5). This service is the typed front door, not the only guard.
 */
export class LedgerService {
  async post(tx: Transaction, input: JournalInput): Promise<PostResult> {
    if (input.postings.length < 2) {
      throw new LedgerError('A journal needs at least two postings');
    }
    const sum = input.postings.reduce((total, p) => total + p.amountPaisa, 0);
    if (sum !== 0) {
      throw new LedgerError(
        `Journal ${input.idempotencyKey} is unbalanced by ${String(sum)} paisa`,
      );
    }

    const [header] = await tx
      .insert(ledgerTransactions)
      .values({
        kind: input.kind,
        idempotency_key: input.idempotencyKey,
        order_id: input.orderId,
        description: input.description ?? null,
      })
      .onConflictDoNothing({ target: ledgerTransactions.idempotency_key })
      .returning({ id: ledgerTransactions.id });
    if (header === undefined) {
      const [existing] = await tx
        .select({ id: ledgerTransactions.id })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.idempotency_key, input.idempotencyKey));
      if (existing === undefined) {
        throw new LedgerError(`Journal ${input.idempotencyKey} conflicted but was not found`);
      }
      return { status: 'duplicate', transactionId: existing.id };
    }

    const resolved = [];
    for (const posting of input.postings) {
      resolved.push({ accountId: await this.resolveAccount(tx, posting.account), posting });
    }
    // Lock account rows in one global order (by id) so concurrent journals cannot deadlock.
    resolved.sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));

    await tx.insert(ledgerEntries).values(
      resolved.map(({ accountId, posting }) => ({
        transaction_id: header.id,
        account_id: accountId,
        amount_npr: toNpr(posting.amountPaisa),
      })),
    );

    const accounts = new Map(
      (
        await tx
          .select()
          .from(ledgerAccounts)
          .where(inArray(ledgerAccounts.id, [...new Set(resolved.map((r) => r.accountId))]))
      ).map((account): [string, LedgerAccount] => [account.id, account]),
    );

    const event = await enqueueDomainEvent(tx, {
      type: 'ledger.mutated',
      aggregateId: input.orderId ?? header.id,
      payload: {
        transaction_id: header.id,
        kind: input.kind,
        order_id: input.orderId,
        entries: resolved.map(({ accountId, posting }) => {
          const account = accounts.get(accountId);
          if (account === undefined) {
            throw new LedgerError(`Account ${accountId} vanished while posting`);
          }
          return {
            account_id: account.id,
            account_type: account.account_type,
            vendor_id: account.vendor_id,
            driver_user_id: account.driver_user_id,
            gateway: account.gateway,
            amount_npr: toNpr(posting.amountPaisa),
            balance_after_npr: account.balance_npr,
          };
        }),
      },
    });

    return { status: 'posted', transactionId: header.id, event };
  }

  private async resolveAccount(tx: Transaction, ref: AccountRef): Promise<string> {
    const condition = (() => {
      switch (ref.type) {
        case 'SYSTEM_ESCROW':
        case 'PLATFORM_REVENUE':
          return eq(ledgerAccounts.account_type, ref.type);
        case 'GATEWAY_CLEARING':
          return eq(ledgerAccounts.gateway, ref.gateway);
        case 'VENDOR_WALLET':
          return eq(ledgerAccounts.vendor_id, ref.vendorId);
        case 'DRIVER_WALLET':
          return eq(ledgerAccounts.driver_user_id, ref.driverUserId);
      }
    })();

    if (ref.type === 'DRIVER_WALLET') {
      await this.ensureDriverAccount(tx, ref.driverUserId);
    }
    const [account] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(condition);
    if (account === undefined) {
      throw new LedgerError(`No ledger account for ${JSON.stringify(ref)}`);
    }
    return account.id;
  }

  /** Driver wallets are opened lazily, on a rider's first settlement. */
  private async ensureDriverAccount(tx: Transaction, driverUserId: string): Promise<void> {
    const [user] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, driverUserId));
    if (user?.role !== 'DRIVER') {
      throw new LedgerError(`User ${driverUserId} is not a DRIVER`);
    }
    await tx
      .insert(ledgerAccounts)
      .values({ account_type: 'DRIVER_WALLET', driver_user_id: driverUserId })
      .onConflictDoNothing({ target: ledgerAccounts.driver_user_id });
  }
}

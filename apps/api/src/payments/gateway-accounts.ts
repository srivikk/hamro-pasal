import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  recordAuditLog,
  vendorGatewayAccounts,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type {
  AuditActor,
  AuditContext,
  GatewayAccountView,
  GatewayAccountWriteRequest,
  GatewayPaymentMethod,
} from '@hamro-pasal/shared-types';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

import { HttpError } from '../http/http-error';
import { isUniqueViolation } from '../infra/pg-errors';

type AccountRow = typeof vendorGatewayAccounts.$inferSelect;

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM sealing of a shop's merchant secret (SPEC core 9, "Model C credentials"):
 * iv (12 bytes) || auth tag (16) || ciphertext. A tampered or foreign blob fails to open.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('VENDOR_CREDENTIALS_KEY must be 32 bytes');
  }

  seal(secret: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Buffer): string {
    const iv = sealed.subarray(0, IV_BYTES);
    const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** A verified merchant account, opened for one payment request. */
export interface MerchantCredentials {
  readonly merchantCode: string;
  readonly secret: string;
}

/** The order's shop has no verified merchant account for this gateway (Model C). */
export class GatewayNotVerifiedError extends HttpError {
  constructor(gateway: GatewayPaymentMethod) {
    super(422, 'GATEWAY_NOT_VERIFIED', `This shop cannot take ${gateway} payments right now`, {
      gateway,
    });
  }
}

export function gatewayAccountView(row: AccountRow): GatewayAccountView {
  if (row.gateway !== 'ESEWA' && row.gateway !== 'KHALTI') {
    throw new Error(`A gateway account for ${row.gateway}`);
  }
  return {
    gateway: row.gateway,
    merchant_code: row.merchant_code,
    secret_hint: row.secret_hint,
    verified_at: row.verified_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * A Model C shop's own eSewa / Khalti merchant accounts (2026-10-21). The vendor saves them; a
 * Super Admin verifies them (a test payment made outside the platform); only a verified account is
 * used to take customers' payments. The secret is sealed with the platform key and opened only to
 * sign or look up one payment.
 */
export class VendorGatewayAccountService {
  constructor(
    private readonly db: Database,
    /** Null without VENDOR_CREDENTIALS_KEY: nothing can be saved or opened (503). */
    private readonly cipher: CredentialCipher | null,
  ) {}

  async list(vendorUserId: string): Promise<GatewayAccountView[]> {
    const vendorId = await this.vendorIdOf(this.db, vendorUserId);
    const rows = await this.db
      .select()
      .from(vendorGatewayAccounts)
      .where(eq(vendorGatewayAccounts.vendor_id, vendorId))
      .orderBy(asc(vendorGatewayAccounts.gateway));
    return rows.map(gatewayAccountView);
  }

  /** PUT /api/vendor/gateway-accounts/:gateway. Any change clears a verification. */
  save(
    actor: AuditActor & { kind: 'USER' },
    gateway: GatewayPaymentMethod,
    input: GatewayAccountWriteRequest,
    context: AuditContext,
  ): Promise<GatewayAccountView> {
    const cipher = this.requireCipher();
    return this.db.transaction(async (tx) => {
      const vendorId = await this.vendorIdOf(tx, actor.user_id, true);
      const [before] = await tx
        .select()
        .from(vendorGatewayAccounts)
        .where(
          and(
            eq(vendorGatewayAccounts.vendor_id, vendorId),
            eq(vendorGatewayAccounts.gateway, gateway),
          ),
        );
      const unchanged =
        before?.merchant_code === input.merchant_code &&
        cipher.open(before.secret_ciphertext) === input.secret_key;
      if (unchanged) return gatewayAccountView(before);

      const values = {
        merchant_code: input.merchant_code,
        secret_ciphertext: cipher.seal(input.secret_key),
        secret_hint: input.secret_key.slice(-4),
        verified_at: null,
        verified_by_user_id: null,
      };
      let row: AccountRow | undefined;
      try {
        [row] = await tx
          .insert(vendorGatewayAccounts)
          .values({ vendor_id: vendorId, gateway, ...values })
          .onConflictDoUpdate({
            target: [vendorGatewayAccounts.vendor_id, vendorGatewayAccounts.gateway],
            set: values,
          })
          .returning();
      } catch (error: unknown) {
        if (isUniqueViolation(error, 'vendor_gateway_accounts_merchant_uidx')) {
          throw new HttpError(
            409,
            'MERCHANT_ACCOUNT_TAKEN',
            'This merchant account is already registered to another shop',
          );
        }
        throw error;
      }
      if (row === undefined) throw new Error('The gateway account was not stored');
      // Never the secret, only that it changed and its hint (forbiddenAuditKeys guards this).
      await recordAuditLog(tx, {
        actor,
        action: 'GATEWAY_ACCOUNT_SAVED',
        entityId: vendorId,
        vendorId,
        beforeState:
          before === undefined
            ? null
            : {
                gateway,
                merchant_code: before.merchant_code,
                hint: before.secret_hint,
                verified: before.verified_at !== null,
              },
        afterState: {
          gateway,
          merchant_code: row.merchant_code,
          hint: row.secret_hint,
          verified: false,
        },
        context,
      });
      return gatewayAccountView(row);
    });
  }

  /** POST /api/admin/vendors/:id/gateway-accounts/:gateway/verify (also on repeat). */
  verify(
    adminUserId: string,
    vendorId: string,
    gateway: GatewayPaymentMethod,
    context: AuditContext,
  ): Promise<GatewayAccountView> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(vendorGatewayAccounts)
        .where(
          and(
            eq(vendorGatewayAccounts.vendor_id, vendorId),
            eq(vendorGatewayAccounts.gateway, gateway),
          ),
        )
        .for('update');
      if (row === undefined) {
        throw new HttpError(404, 'GATEWAY_ACCOUNT_NOT_FOUND', 'This shop has no such account');
      }
      if (row.verified_at !== null) return gatewayAccountView(row);
      const [verified] = await tx
        .update(vendorGatewayAccounts)
        .set({ verified_at: new Date(), verified_by_user_id: adminUserId })
        .where(
          and(
            eq(vendorGatewayAccounts.vendor_id, vendorId),
            eq(vendorGatewayAccounts.gateway, gateway),
          ),
        )
        .returning();
      if (verified === undefined) throw new Error('The gateway account vanished');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'GATEWAY_ACCOUNT_VERIFIED',
        entityId: vendorId,
        vendorId,
        beforeState: { gateway, verified: false },
        afterState: { gateway, merchant_code: verified.merchant_code, verified: true },
        context,
      });
      return gatewayAccountView(verified);
    });
  }

  /** The gateways a shop may take payments through as Model C: its verified accounts. */
  async verifiedGateways(
    executor: Database | Transaction,
    vendorId: string,
  ): Promise<GatewayPaymentMethod[]> {
    const rows = await executor
      .select({ gateway: vendorGatewayAccounts.gateway })
      .from(vendorGatewayAccounts)
      .where(
        and(
          eq(vendorGatewayAccounts.vendor_id, vendorId),
          isNotNull(vendorGatewayAccounts.verified_at),
        ),
      );
    return rows.flatMap(({ gateway }) =>
      gateway === 'ESEWA' || gateway === 'KHALTI' ? [gateway] : [],
    );
  }

  /** Opens a verified account's secret for one payment; GATEWAY_NOT_VERIFIED otherwise. */
  async credentialsFor(
    vendorId: string,
    gateway: GatewayPaymentMethod,
  ): Promise<MerchantCredentials> {
    const [row] = await this.db
      .select()
      .from(vendorGatewayAccounts)
      .where(
        and(
          eq(vendorGatewayAccounts.vendor_id, vendorId),
          eq(vendorGatewayAccounts.gateway, gateway),
          isNotNull(vendorGatewayAccounts.verified_at),
        ),
      );
    if (row === undefined || this.cipher === null) throw new GatewayNotVerifiedError(gateway);
    return { merchantCode: row.merchant_code, secret: this.cipher.open(row.secret_ciphertext) };
  }

  private requireCipher(): CredentialCipher {
    if (this.cipher === null) {
      throw new HttpError(
        503,
        'GATEWAY_CREDENTIALS_UNAVAILABLE',
        'Merchant accounts cannot be saved right now',
      );
    }
    return this.cipher;
  }

  private async vendorIdOf(
    executor: Database | Transaction,
    userId: string,
    lock = false,
  ): Promise<string> {
    const query = executor
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, userId));
    const [vendor] = lock ? await query.for('no key update') : await query;
    if (vendor === undefined)
      throw new HttpError(404, 'VENDOR_NOT_FOUND', 'No shop for this account');
    return vendor.id;
  }
}

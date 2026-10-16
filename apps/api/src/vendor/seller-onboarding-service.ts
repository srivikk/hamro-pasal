import {
  enqueueDomainEvent,
  pricingPlans,
  recordAuditLog,
  userRoles,
  users,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import type {
  AdminVendorCreateRequest,
  AuditActor,
  AuditContext,
  DisputeEvidenceContentType,
  SellerApplicationView,
  SellerSignupRequest,
} from '@hamro-pasal/shared-types';
import type { SmsGateway } from '@hamro-pasal/sms';
import { and, eq } from 'drizzle-orm';

import type { AuthSession, OtpAuthService } from '../auth/otp-auth-service';
import { verifySellerSignupToken } from '../auth/seller-signup-token';
import { HttpError } from '../http/errors';
import { isUniqueViolation } from '../infra/pg-errors';
import type { KycDocumentStorage } from '../uploads/kyc-document-storage';

type VendorRow = typeof vendors.$inferSelect;

/** The details both onboarding paths take: the shop, where it is, how it delivers. */
type ShopDetails = Pick<
  SellerSignupRequest,
  | 'business_name'
  | 'municipality_palika_string'
  | 'location'
  | 'fulfillment_mode'
  | 'delivery_scope'
  | 'radius_km'
>;

export interface SellerOnboardingConfig {
  /** The Seller app's link in the invitation SMS (its store page). */
  readonly sellerAppUrl: string;
  /** The refresh secret the signup token is signed with. */
  readonly refreshTokenSecret: string;
}

export interface SignedUpSeller {
  readonly application: SellerApplicationView;
  /** A vendor session for the Seller app: signing up granted the vendor role. */
  readonly session: AuthSession;
}

export function applicationView(vendor: VendorRow): SellerApplicationView {
  const pan = vendor.pan_document_url !== null;
  const citizenship = vendor.citizenship_document_url !== null;
  const taxId = vendor.tax_id !== null;
  return {
    vendor_id: vendor.id,
    vendor_code: vendor.vendor_code,
    business_name: vendor.business_name,
    status: vendor.status,
    pan_document_uploaded: pan,
    citizenship_document_uploaded: citizenship,
    tax_id_saved: taxId,
    ready_for_review: pan && citizenship && taxId,
    created_at: vendor.created_at.toISOString(),
  };
}

/**
 * Step 7.7 (SPEC core 11, vendor flow 2, verification 32): how a shop comes onto the platform.
 *  - **Self-signup** in the Seller app: the number passed its OTP (the signup token proves it), the
 *    shop is created SANDBOXED on that same account, which gains the vendor role (one account,
 *    several roles), and the app gets a vendor session at once.
 *  - **By a Super Admin**: the account is created (or found) for the number, given the vendor
 *    role, the shop created SANDBOXED or APPROVED, and an SMS invites the owner to the Seller app,
 *    where it signs in with that number.
 *  - **Approval** (SANDBOXED -> APPROVED), the step vendor flow 4 never had a route for, once the
 *    PAN and citizenship documents and the PAN are in.
 * A new shop takes the default pricing plan's terms when one is set.
 */
export class SellerOnboardingService {
  constructor(
    private readonly db: Database,
    private readonly auth: OtpAuthService,
    private readonly documents: KycDocumentStorage,
    private readonly sms: SmsGateway,
    private readonly config: SellerOnboardingConfig,
  ) {}

  /** POST /api/seller/signup. */
  async signup(request: SellerSignupRequest, context: AuditContext): Promise<SignedUpSeller> {
    const userId = verifySellerSignupToken(request.signup_token, this.config.refreshTokenSecret);
    const vendor = await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user === undefined) throw new HttpError(401, 'INVALID_SIGNUP_TOKEN', 'Account not found');
      const created = await this.createShop(tx, user.id, user.phone, request, 'SANDBOXED');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: user.id, role: 'VENDOR' },
        action: 'VENDOR_SIGNED_UP',
        entityId: created.id,
        vendorId: created.id,
        beforeState: {},
        afterState: shopState(created),
        context,
      });
      await enqueueDomainEvent(tx, {
        type: 'vendor.signed_up',
        aggregateId: created.id,
        payload: {
          vendor_id: created.id,
          vendor_code: created.vendor_code,
          business_name: created.business_name,
          signed_up_at: created.created_at.toISOString(),
        },
      });
      return { created, user };
    });
    return {
      application: applicationView(vendor.created),
      session: await this.auth.sessionFor(vendor.user, 'VENDOR'),
    };
  }

  /** GET /api/seller/application: the signed-in vendor's own shop. */
  async application(vendorUserId: string): Promise<SellerApplicationView> {
    return applicationView(await this.vendorOf(this.db, vendorUserId));
  }

  /** POST /api/vendor/kyc/citizenship-document (vendor flow 2): the private store, audited. */
  async uploadCitizenshipDocument(
    actor: AuditActor & { kind: 'USER' },
    image: { readonly bytes: Buffer; readonly contentType: DisputeEvidenceContentType },
    context: AuditContext,
  ): Promise<SellerApplicationView> {
    const shop = await this.vendorOf(this.db, actor.user_id);
    const key = await this.documents.saveCitizenshipDocument(
      shop.id,
      image.bytes,
      image.contentType,
    );
    // Written inside the transaction callback, so read through an object.
    const replaced: { key: string | null } = { key: null };
    let after: VendorRow;
    try {
      after = await this.db.transaction(async (tx) => {
        const before = await this.vendorOf(tx, actor.user_id, true);
        replaced.key = before.citizenship_document_url;
        const [row] = await tx
          .update(vendors)
          .set({ citizenship_document_url: key })
          .where(eq(vendors.id, before.id))
          .returning();
        if (row === undefined) throw new Error(`Vendor ${before.id} vanished`);
        await recordAuditLog(tx, {
          actor,
          action: 'CITIZENSHIP_DOCUMENT_UPLOADED',
          entityId: before.id,
          vendorId: before.id,
          beforeState: { citizenship_document_url: before.citizenship_document_url },
          afterState: { citizenship_document_url: key, size_bytes: image.bytes.length },
          context,
        });
        return row;
      });
    } catch (error: unknown) {
      await this.documents.deleteFile(key);
      throw error;
    }
    // Best effort: the replaced document is no longer needed.
    if (replaced.key !== null) await this.documents.deleteFile(replaced.key).catch(() => false);
    return applicationView(after);
  }

  /** POST /api/admin/vendors. */
  async adminCreate(
    adminUserId: string,
    request: AdminVendorCreateRequest,
    context: AuditContext,
  ): Promise<{ vendor: VendorRow; accountCreated: boolean; inviteSent: boolean }> {
    const { vendor, accountCreated } = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(users)
        .values({ phone: request.phone, role: 'VENDOR' })
        .onConflictDoNothing({ target: users.phone })
        .returning();
      const [user] =
        inserted === undefined
          ? await tx.select().from(users).where(eq(users.phone, request.phone)).for('update')
          : [inserted];
      if (user === undefined) throw new Error('Account vanished');
      const created = await this.createShop(tx, user.id, user.phone, request, request.status);
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'VENDOR_ONBOARDED',
        entityId: created.id,
        vendorId: created.id,
        beforeState: {},
        afterState: { ...shopState(created), account_created: inserted !== undefined },
        context,
      });
      return { vendor: created, accountCreated: inserted !== undefined };
    });

    let inviteSent = false;
    try {
      await this.sms.send({
        to: vendor.phone,
        text:
          `Hamro Pasal: your shop "${vendor.business_name}" (${vendor.vendor_code}) is ready. ` +
          `Get the Hamro Pasal Seller app and sign in with this number: ${this.config.sellerAppUrl}`,
      });
      inviteSent = true;
    } catch {
      // The shop exists either way; the admin can tell the owner, and the answer says so.
    }
    return { vendor, accountCreated, inviteSent };
  }

  /** POST /api/admin/vendors/:id/approve. */
  async approve(adminUserId: string, vendorId: string, context: AuditContext): Promise<VendorRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (before === undefined) throw new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
      if (before.status !== 'SANDBOXED') {
        throw new HttpError(409, 'NOT_SANDBOXED', `The shop is ${before.status}, not SANDBOXED`);
      }
      const missing = [
        ...(before.pan_document_url === null ? ['PAN_DOCUMENT'] : []),
        ...(before.citizenship_document_url === null ? ['CITIZENSHIP_DOCUMENT'] : []),
        ...(before.tax_id === null ? ['TAX_ID'] : []),
      ];
      if (missing.length > 0) {
        throw new HttpError(422, 'KYC_INCOMPLETE', 'The shop has not sent every KYC document', {
          missing,
        });
      }
      const [after] = await tx
        .update(vendors)
        .set({ status: 'APPROVED' })
        .where(eq(vendors.id, vendorId))
        .returning();
      if (after === undefined) throw new Error(`Vendor ${vendorId} vanished`);
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'VENDOR_APPROVED',
        entityId: vendorId,
        vendorId,
        beforeState: { status: before.status },
        afterState: { status: after.status },
        context,
      });
      return after;
    });
  }

  /** The shop row and the vendor role, in the caller's transaction. One shop per account. */
  private async createShop(
    tx: Transaction,
    userId: string,
    phone: string,
    details: ShopDetails,
    status: 'SANDBOXED' | 'APPROVED',
  ): Promise<VendorRow> {
    const [plan] = await tx
      .select({ id: pricingPlans.id, rate: pricingPlans.commission_rate })
      .from(pricingPlans)
      .where(and(eq(pricingPlans.is_default, true), eq(pricingPlans.model, 'COMMISSION')));
    let created: VendorRow | undefined;
    try {
      [created] = await tx
        .insert(vendors)
        .values({
          user_id: userId,
          business_name: details.business_name,
          phone,
          status,
          pricing_model: plan === undefined ? null : 'COMMISSION',
          pricing_plan_id: plan?.id ?? null,
          commission_rate: plan === undefined ? 0 : plan.rate / 100,
          delivery_scope: details.delivery_scope,
          fulfillment_mode: details.fulfillment_mode,
          radius_km: details.radius_km,
          municipality_palika_string: details.municipality_palika_string,
          min_order_value: 0,
          base_delivery_fee_npr: 0,
          location: { x: details.location.lng, y: details.location.lat },
        })
        .returning();
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'vendors_user_id_unique')) {
        throw new HttpError(409, 'ALREADY_A_SELLER', 'This number already has a shop');
      }
      throw error;
    }
    if (created === undefined) throw new Error('Vendor not created');
    await tx.insert(userRoles).values({ user_id: userId, role: 'VENDOR' }).onConflictDoNothing();
    return created;
  }

  private async vendorOf(
    executor: Database | Transaction,
    userId: string,
    lock = false,
  ): Promise<VendorRow> {
    const query = executor.select().from(vendors).where(eq(vendors.user_id, userId));
    const [vendor] = lock ? await query.for('update') : await query;
    if (vendor === undefined)
      throw new HttpError(404, 'VENDOR_NOT_FOUND', 'No shop for this account');
    return vendor;
  }
}

function shopState(vendor: VendorRow) {
  return {
    vendor_code: vendor.vendor_code,
    business_name: vendor.business_name,
    status: vendor.status,
    municipality_palika_string: vendor.municipality_palika_string,
    fulfillment_mode: vendor.fulfillment_mode,
    delivery_scope: vendor.delivery_scope,
  };
}

import {
  enqueueDomainEvent,
  platformSettings,
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
  OfferedPlanView,
  SellerApplicationView,
  SellerSignupRequest,
} from '@hamro-pasal/shared-types';
import type { SmsGateway } from '@hamro-pasal/sms';
import { isPanVerified, panGatedStanding } from '@hamro-pasal/shared-types';
import { and, eq } from 'drizzle-orm';

import type { AuthSession, OtpAuthService } from '../auth/otp-auth-service';
import { verifySellerSignupToken } from '../auth/seller-signup-token';
import { HttpError } from '../http/http-error';
import { isUniqueViolation } from '../infra/pg-errors';
import type { KycDocumentStorage } from '../uploads/kyc-document-storage';
import { offeredPlanView, selfSelectablePlans } from './vendor-billing-service';
import { DeliveryModeDisabledError } from './vendor-delivery-settings-service';

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
/**
 * Both delivery modes are switched off platform-wide (2026-10-20): a new shop could deliver no
 * order, so self-signup is paused until the Super Admin switches one back on.
 */
export class SellerSignupsPausedError extends Error {
  constructor() {
    super('New shop registrations are currently paused');
    this.name = 'SellerSignupsPausedError';
  }
}

/** The platform's delivery switches, as a new shop may use them. */
export interface SignupOptions {
  readonly selfDeliveryEnabled: boolean;
  readonly platformFleetEnabled: boolean;
  /** Decided 2026-10-21: the plans a self-signing shop may choose (Subscription only). */
  readonly subscriptionPlans: readonly OfferedPlanView[];
}

/** The plan a self-signup named is not an offered Subscription plan (decided 2026-10-21). */
export class PlanNotSelfSelectableError extends HttpError {
  constructor(planId: string) {
    super(
      422,
      'PRICING_PLAN_NOT_SELF_SELECTABLE',
      'Choose one of the Subscription plans on offer',
      { pricing_plan_id: planId },
    );
  }
}

export class SellerOnboardingService {
  constructor(
    private readonly db: Database,
    private readonly auth: OtpAuthService,
    private readonly documents: KycDocumentStorage,
    private readonly sms: SmsGateway,
    private readonly config: SellerOnboardingConfig,
  ) {}

  /** GET /api/seller/signup-options: what the Seller app may offer a new shop. */
  async signupOptions(): Promise<SignupOptions> {
    return readSignupOptions(this.db);
  }

  /**
   * POST /api/seller/signup. The delivery mode must be one the Super Admin has switched on
   * (2026-10-20): 422 DELIVERY_MODE_DISABLED otherwise, and 409 SELLER_SIGNUPS_PAUSED while both
   * are off. The switches are read FOR SHARE in the shop's transaction, so an admin turning a
   * mode off (which updates that row) either commits first and is seen here, or waits for it.
   */
  async signup(request: SellerSignupRequest, context: AuditContext): Promise<SignedUpSeller> {
    const userId = verifySellerSignupToken(request.signup_token, this.config.refreshTokenSecret);
    const vendor = await this.db.transaction(async (tx) => {
      const options = await readSignupOptions(tx, true);
      if (
        (!options.selfDeliveryEnabled && !options.platformFleetEnabled) ||
        options.subscriptionPlans.length === 0
      ) {
        throw new SellerSignupsPausedError();
      }
      const plan = options.subscriptionPlans.find((p) => p.id === request.pricing_plan_id);
      if (plan === undefined) throw new PlanNotSelfSelectableError(request.pricing_plan_id);
      const enabled =
        request.fulfillment_mode === 'SELF_DELIVERY'
          ? options.selfDeliveryEnabled
          : options.platformFleetEnabled;
      if (!enabled) throw new DeliveryModeDisabledError(request.fulfillment_mode);
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user === undefined) throw new HttpError(401, 'INVALID_SIGNUP_TOKEN', 'Account not found');
      const created = await this.createShop(tx, user.id, user.phone, request, 'SANDBOXED', {
        id: plan.id,
        model: 'SUBSCRIPTION',
        rate: 0,
      });
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
      const created = await this.createShop(
        tx,
        user.id,
        user.phone,
        request,
        request.status,
        await defaultPlan(tx),
      );
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

  /**
   * POST /api/admin/vendors/:id/approve. Approval is what takes a shop LIVE (decided 2026-10-20:
   * the shop already holds the default Commission plan, which stands for SPEC vendor flow step 5's
   * choice). Through the PAN gate: without a verified PAN the shop is SUSPENDED_COMPLIANCE,
   * remembering LIVE, and the admin's PAN verification then makes it LIVE. A shop left APPROVED by
   * the earlier rule (approval stopped there and nothing went further) is approved the same way.
   */
  async approve(adminUserId: string, vendorId: string, context: AuditContext): Promise<VendorRow> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(vendors)
        .where(eq(vendors.id, vendorId))
        .for('update');
      if (before === undefined) throw new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
      if (before.status !== 'SANDBOXED' && before.status !== 'APPROVED') {
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
        .set(await goLiveColumns(tx, before))
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
    /**
     * The plan the shop starts on: the Subscription plan a self-signup chose, or (an admin's
     * onboarding) the default Commission plan, which the admin may change (2026-10-21).
     */
    plan: ShopPlan | undefined,
  ): Promise<VendorRow> {
    let created: VendorRow | undefined;
    try {
      [created] = await tx
        .insert(vendors)
        .values({
          user_id: userId,
          business_name: details.business_name,
          phone,
          status,
          pricing_model: plan === undefined ? null : plan.model,
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
    // An admin onboarding a shop "approved" makes it LIVE through the PAN gate, as approve() does:
    // a new shop has no verified PAN, so it waits in SUSPENDED_COMPLIANCE for the verification.
    if (status === 'APPROVED') {
      [created] = await tx
        .update(vendors)
        .set(await goLiveColumns(tx, created))
        .where(eq(vendors.id, created.id))
        .returning();
      if (created === undefined) throw new Error('Vendor vanished');
    }
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

/** The platform's delivery switches; locked FOR SHARE inside a signup's transaction. */
async function readSignupOptions(
  executor: Database | Transaction,
  lock = false,
): Promise<SignupOptions> {
  const query = executor
    .select({
      selfDeliveryEnabled: platformSettings.self_delivery_enabled,
      platformFleetEnabled: platformSettings.platform_fleet_enabled,
    })
    .from(platformSettings);
  const [settings] = lock ? await query.for('share') : await query;
  if (settings === undefined) throw new Error('platform_settings row is missing');
  return {
    ...settings,
    subscriptionPlans: (await selfSelectablePlans(executor)).map(offeredPlanView),
  };
}

/** The plan a new shop starts on. */
interface ShopPlan {
  readonly id: string;
  readonly model: 'COMMISSION' | 'SUBSCRIPTION';
  /** Percent. */
  readonly rate: number;
}

/** The one default Commission plan (exactly one may exist), or undefined when none is published. */
async function defaultPlan(tx: Transaction): Promise<ShopPlan | undefined> {
  const [plan] = await tx
    .select({ id: pricingPlans.id, rate: pricingPlans.commission_rate })
    .from(pricingPlans)
    .where(and(eq(pricingPlans.is_default, true), eq(pricingPlans.model, 'COMMISSION')));
  return plan === undefined ? undefined : { ...plan, model: 'COMMISSION' };
}

/**
 * What a shop's row becomes when an admin's approval takes it LIVE: through the PAN gate, and with
 * a pricing model (a LIVE shop must have one: vendors_live_requires_pricing_model_check). A shop
 * created while no default plan existed takes the default Commission plan now; with none published
 * the approval is refused (409 DEFAULT_PLAN_REQUIRED) rather than failing on the CHECK.
 */
async function goLiveColumns(tx: Transaction, shop: VendorRow) {
  const standing = panGatedStanding('LIVE', isPanVerified(shop));
  // SPEC core 4: a subscription's 90-day lock-in starts when the shop goes LIVE on it.
  if (shop.pricing_model === 'SUBSCRIPTION' && shop.lock_in_expiry === null) {
    return { ...standing, lock_in_expiry: new Date(Date.now() + 90 * 86_400_000) };
  }
  if (shop.pricing_model !== null) return standing;
  const plan = await defaultPlan(tx);
  if (plan === undefined) {
    throw new HttpError(
      409,
      'DEFAULT_PLAN_REQUIRED',
      'Publish a default Commission pricing plan before approving a shop',
    );
  }
  return {
    ...standing,
    pricing_model: 'COMMISSION' as const,
    pricing_plan_id: plan.id,
    commission_rate: plan.rate / 100,
  };
}

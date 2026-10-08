import {
  campaignOptIns,
  platformCampaigns,
  recordAuditLog,
  vendors,
  type Database,
} from '@hamro-pasal/db';
import {
  NO_AUDIT_CONTEXT,
  type AuditActor,
  type AuditContext,
  type CampaignWrite,
} from '@hamro-pasal/shared-types';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { VendorAccountNotFoundError } from '../orders/vendor-order-service';

export type CampaignRow = typeof platformCampaigns.$inferSelect;
export type CampaignOptInRow = typeof campaignOptIns.$inferSelect;

export interface CampaignWithCount {
  readonly campaign: CampaignRow;
  /** Shops opted in to the current terms version. */
  readonly optInCount: number;
}

export interface CampaignOptInResult {
  readonly optIn: CampaignOptInRow;
  /** False when the shop was already opted in to these terms. */
  readonly created: boolean;
}

/** Unknown, or (for a vendor) not published: an unpublished campaign is invisible to shops. */
export class CampaignNotFoundError extends Error {
  constructor(readonly campaignId: string) {
    super(`Campaign ${campaignId} not found`);
    this.name = 'CampaignNotFoundError';
  }
}

/** The vendor accepted a terms version that is not the campaign's current one. */
export class CampaignTermsChangedError extends Error {
  constructor(
    readonly campaignId: string,
    readonly currentTermsVersion: number,
  ) {
    super('The campaign terms changed: review the new terms before opting in');
    this.name = 'CampaignTermsChangedError';
  }
}

/** Opting out of a campaign the shop has no opt-in for (never joined, or its opt-in was voided). */
export class CampaignNotOptedInError extends Error {
  constructor(readonly campaignId: string) {
    super('The shop is not opted in to this campaign');
    this.name = 'CampaignNotOptedInError';
  }
}

/** A campaign as one shop sees it: the campaign and that shop's latest opt-in, if any. */
export interface VendorCampaign {
  readonly campaign: CampaignRow;
  readonly latestOptIn: CampaignOptInRow | null;
}

export class CampaignEndedError extends Error {
  constructor(readonly campaignId: string) {
    super('This campaign has ended');
    this.name = 'CampaignEndedError';
  }
}

/** The seven terms a vendor agrees to (SPEC core 7): the dates are terms too. */
function termsOf(campaign: CampaignRow) {
  return {
    kind: campaign.kind,
    value: campaign.value,
    max_discount_npr: campaign.max_discount_npr,
    min_cart_npr: campaign.min_cart_npr,
    vendor_share_percent: campaign.vendor_share_percent,
    starts_at: campaign.starts_at.toISOString(),
    ends_at: campaign.ends_at.toISOString(),
  };
}

function campaignState(campaign: CampaignRow) {
  return {
    name: campaign.name,
    is_active: campaign.is_active,
    terms_version: campaign.terms_version,
    terms: termsOf(campaign),
  };
}

function columnsOf(input: CampaignWrite) {
  return {
    name: input.name,
    kind: input.kind,
    value: input.value,
    max_discount_npr: input.max_discount_npr,
    min_cart_npr: input.min_cart_npr,
    vendor_share_percent: input.vendor_share_percent,
    starts_at: new Date(input.starts_at),
    ends_at: new Date(input.ends_at),
    is_active: input.is_active,
  };
}

const activeOptInCount = sql<number>`(SELECT count(*) FROM campaign_opt_ins o
    WHERE o.campaign_id = "platform_campaigns"."id" AND o.status = 'ACTIVE')::int`;

/**
 * Platform campaigns (SPEC core 7).
 *
 * - **An admin publishes; only a shop enrols itself.** This service has no method that creates an
 *   opt-in for an admin, and the database refuses a row the shop's own account did not create.
 * - **Terms are versioned.** `update` compares the seven terms (dates included); if any changed
 *   it raises `terms_version` by one in the same UPDATE, and the database trigger of migration
 *   0024 voids every ACTIVE opt-in in that transaction. The version is never taken from a request.
 * - **An opt-in is consent to one version.** `optIn` refuses a version that is not the current
 *   one, and stores the terms exactly as they stood.
 */
export class CampaignService {
  constructor(private readonly db: Database) {}

  /** Every campaign, unpublished and ended ones included, newest first. */
  async list(): Promise<CampaignWithCount[]> {
    return this.db
      .select({ campaign: platformCampaigns, optInCount: activeOptInCount })
      .from(platformCampaigns)
      .orderBy(desc(platformCampaigns.created_at), desc(platformCampaigns.id));
  }

  create(
    adminUserId: string,
    input: CampaignWrite,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<CampaignWithCount> {
    return this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .insert(platformCampaigns)
        .values({ ...columnsOf(input), created_by_user_id: adminUserId })
        .returning();
      if (campaign === undefined) throw new Error('The campaign was not stored');
      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: 'CAMPAIGN_CREATED',
        entityId: campaign.id,
        vendorId: null,
        beforeState: null,
        afterState: campaignState(campaign),
        context,
      });
      return { campaign, optInCount: 0 };
    });
  }

  /** Replaces every field, under the campaign row lock an opt-in also takes. */
  update(
    adminUserId: string,
    campaignId: string,
    input: CampaignWrite,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<CampaignWithCount> {
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(platformCampaigns)
        .where(eq(platformCampaigns.id, campaignId))
        .for('update');
      if (before === undefined) throw new CampaignNotFoundError(campaignId);

      const next = columnsOf(input);
      const termsChanged =
        before.kind !== next.kind ||
        before.value !== next.value ||
        before.max_discount_npr !== next.max_discount_npr ||
        before.min_cart_npr !== next.min_cart_npr ||
        before.vendor_share_percent !== next.vendor_share_percent ||
        before.starts_at.getTime() !== next.starts_at.getTime() ||
        before.ends_at.getTime() !== next.ends_at.getTime();
      const [live] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(campaignOptIns)
        .where(
          and(eq(campaignOptIns.campaign_id, campaignId), eq(campaignOptIns.status, 'ACTIVE')),
        );
      const optInsBefore = live?.count ?? 0;
      if (!termsChanged && before.name === next.name && before.is_active === next.is_active) {
        return { campaign: before, optInCount: optInsBefore };
      }

      // New terms are a new version; the trigger voids the consent given to the old one.
      const [after] = await tx
        .update(platformCampaigns)
        .set({ ...next, terms_version: before.terms_version + (termsChanged ? 1 : 0) })
        .where(eq(platformCampaigns.id, campaignId))
        .returning();
      if (after === undefined) throw new CampaignNotFoundError(campaignId);

      await recordAuditLog(tx, {
        actor: { kind: 'USER', user_id: adminUserId, role: 'SUPER_ADMIN' },
        action: termsChanged ? 'CAMPAIGN_TERMS_CHANGED' : 'CAMPAIGN_UPDATED',
        entityId: campaignId,
        vendorId: null,
        beforeState: campaignState(before),
        afterState: termsChanged
          ? { ...campaignState(after), voided_opt_in_count: optInsBefore }
          : campaignState(after),
        context,
      });
      return { campaign: after, optInCount: termsChanged ? 0 : optInsBefore };
    });
  }

  /**
   * The shop's own account accepts a campaign's terms. One transaction under the vendor row lock
   * (two opt-ins of one shop run one after another) and the campaign row lock FOR SHARE (a terms
   * change waits for it, or it waits for the change), with its audit entry.
   */
  optIn(
    actor: AuditActor & { kind: 'USER' },
    campaignId: string,
    termsVersion: number,
    context: AuditContext,
  ): Promise<CampaignOptInResult> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (vendor === undefined) throw new VendorAccountNotFoundError(actor.user_id);

      const [campaign] = await tx
        .select()
        .from(platformCampaigns)
        .where(eq(platformCampaigns.id, campaignId))
        .for('share');
      if (campaign?.is_active !== true) throw new CampaignNotFoundError(campaignId);
      const { rows } = await tx.execute<{ ended: boolean }>(
        sql`SELECT now() >= ${campaign.ends_at.toISOString()}::timestamptz AS ended`,
      );
      if (rows[0]?.ended === true) throw new CampaignEndedError(campaignId);
      // The consent is to exactly the terms that stand now.
      if (termsVersion !== campaign.terms_version) {
        throw new CampaignTermsChangedError(campaignId, campaign.terms_version);
      }

      const [existing] = await tx
        .select()
        .from(campaignOptIns)
        .where(
          and(
            eq(campaignOptIns.campaign_id, campaignId),
            eq(campaignOptIns.vendor_id, vendor.id),
            eq(campaignOptIns.status, 'ACTIVE'),
          ),
        );
      if (existing !== undefined) return { optIn: existing, created: false };

      const [optIn] = await tx
        .insert(campaignOptIns)
        .values({
          campaign_id: campaignId,
          vendor_id: vendor.id,
          opt_in_terms_version: campaign.terms_version,
          terms_snapshot: termsOf(campaign),
          opted_in_by_user_id: actor.user_id,
        })
        .returning();
      if (optIn === undefined) throw new Error('The opt-in was not stored');

      await recordAuditLog(tx, {
        actor,
        action: 'CAMPAIGN_OPTED_IN',
        entityId: optIn.id,
        vendorId: vendor.id,
        beforeState: null,
        afterState: {
          campaign_id: campaignId,
          campaign_name: campaign.name,
          opt_in_terms_version: optIn.opt_in_terms_version,
          terms: termsOf(campaign),
          opted_in_at: optIn.opted_in_at.toISOString(),
        },
        context,
      });
      return { optIn, created: true };
    });
  }

  /**
   * GET /api/vendor/campaigns: the campaigns that have not ended and are published, each with
   * the shop's latest opt-in. A campaign unpublished after the shop joined is still listed while
   * its opt-in is ACTIVE (unpublishing is not a change of terms and voids nothing), so the shop
   * can see what applies to it and leave. The soonest to end first.
   */
  async listForVendor(vendorUserId: string): Promise<VendorCampaign[]> {
    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.user_id, vendorUserId));
    if (vendor === undefined) throw new VendorAccountNotFoundError(vendorUserId);

    const running = await this.db
      .select()
      .from(platformCampaigns)
      .where(sql`${platformCampaigns.ends_at} > now()`)
      .orderBy(asc(platformCampaigns.ends_at), asc(platformCampaigns.id));
    if (running.length === 0) return [];

    const optIns = await this.db
      .select()
      .from(campaignOptIns)
      .where(
        and(
          eq(campaignOptIns.vendor_id, vendor.id),
          inArray(
            campaignOptIns.campaign_id,
            running.map((campaign) => campaign.id),
          ),
        ),
      )
      .orderBy(desc(campaignOptIns.opted_in_at), desc(campaignOptIns.id));
    const latest = new Map<string, CampaignOptInRow>();
    for (const optIn of optIns) {
      if (!latest.has(optIn.campaign_id)) latest.set(optIn.campaign_id, optIn);
    }

    return running
      .map((campaign) => ({ campaign, latestOptIn: latest.get(campaign.id) ?? null }))
      .filter(
        ({ campaign, latestOptIn }) => campaign.is_active || latestOptIn?.status === 'ACTIVE',
      );
  }

  /**
   * The shop's own account leaves a campaign: its ACTIVE opt-in becomes OPTED_OUT, with its audit
   * entry, under the vendor row lock. It stops future orders only. A repeat answers the opt-in
   * already closed; the database refuses an opt-out by anyone but the shop's own user.
   */
  optOut(
    actor: AuditActor & { kind: 'USER' },
    campaignId: string,
    context: AuditContext = NO_AUDIT_CONTEXT,
  ): Promise<CampaignOptInRow> {
    return this.db.transaction(async (tx) => {
      const [vendor] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(eq(vendors.user_id, actor.user_id))
        .for('update');
      if (vendor === undefined) throw new VendorAccountNotFoundError(actor.user_id);

      const [campaign] = await tx
        .select({ id: platformCampaigns.id, name: platformCampaigns.name })
        .from(platformCampaigns)
        .where(eq(platformCampaigns.id, campaignId));
      if (campaign === undefined) throw new CampaignNotFoundError(campaignId);

      const [latest] = await tx
        .select()
        .from(campaignOptIns)
        .where(
          and(eq(campaignOptIns.campaign_id, campaignId), eq(campaignOptIns.vendor_id, vendor.id)),
        )
        .orderBy(desc(campaignOptIns.opted_in_at), desc(campaignOptIns.id))
        .limit(1)
        .for('update');
      if (latest?.status === 'OPTED_OUT') return latest;
      if (latest?.status !== 'ACTIVE') throw new CampaignNotOptedInError(campaignId);

      const [closed] = await tx
        .update(campaignOptIns)
        .set({ status: 'OPTED_OUT', closed_at: sql`now()`, closed_by_user_id: actor.user_id })
        .where(and(eq(campaignOptIns.id, latest.id), eq(campaignOptIns.status, 'ACTIVE')))
        .returning();
      if (closed === undefined) throw new CampaignNotOptedInError(campaignId);

      await recordAuditLog(tx, {
        actor,
        action: 'CAMPAIGN_OPTED_OUT',
        entityId: closed.id,
        vendorId: vendor.id,
        beforeState: { status: latest.status, opt_in_terms_version: latest.opt_in_terms_version },
        afterState: {
          campaign_id: campaignId,
          campaign_name: campaign.name,
          status: closed.status,
          opt_in_terms_version: closed.opt_in_terms_version,
          closed_at: closed.closed_at?.toISOString() ?? null,
        },
        context,
      });
      return closed;
    });
  }
}

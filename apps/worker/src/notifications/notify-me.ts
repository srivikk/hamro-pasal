import {
  deviceTokens,
  inVisibleCategory,
  products,
  recordNotificationMessage,
  shopOpenAlerts,
  stockAlerts,
  users,
  vendorClosedReason,
  vendors,
  type Database,
  type Transaction,
} from '@hamro-pasal/db';
import { ALERT_NOTICE_BATCH_SIZE, type LanguagePreference } from '@hamro-pasal/shared-types';
import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';

import type { ExpoPushMessage, PushGateway, PushTicket } from '../push/expo-push';
import { EXPO_DEVICE_NOT_REGISTERED } from '../push/expo-push';

/** What one Notify Me notice says, in the customer's language. */
interface NoticeText {
  readonly title: string;
  readonly body: string;
}

type NoticeSubject =
  | { readonly kind: 'BACK_IN_STOCK'; readonly productId: string }
  | { readonly kind: 'SHOP_OPEN'; readonly vendorId: string };

/** How many customers one call told. */
export interface NotifyMeOutcome {
  readonly notified: number;
}

export interface NotifyMeSweepSummary {
  readonly products: number;
  readonly shops: number;
  readonly notified: number;
}

/**
 * Step 7.4 (SPEC core 11, Notify Me). A waiting customer gets one notification centre message
 * and one push, and the request is used up. In batches of ALERT_NOTICE_BATCH_SIZE customers, each
 * in one transaction: the requests are deleted (`RETURNING user_id`) and the message is written
 * together, so a request is used up exactly when its notice is kept (SPEC edge case 22) and a
 * retried event finds nothing left to do. The push follows the commit and is best effort: the
 * notification centre is the record, as for vendor notices.
 *
 * A message is written per language of the batch (en / ne), each naming its own recipients.
 */
export class NotifyMeService {
  constructor(
    private readonly db: Database,
    private readonly push: PushGateway,
  ) {}

  /**
   * `product.back_in_stock`: everyone waiting for the product. Not re-checked against the stock:
   * a product restocked and sold out again within the minute still tells them (edge case 22).
   *
   * Decided 2026-10-20: a product filed under a hidden category, or under any category below a
   * hidden one, tells nobody yet: the customer could not find it in the app. The requests are
   * left untouched (delayed, never deleted), and the sweep sends the notices once the category is
   * shown again while the product is still in stock.
   */
  async productBackInStock(productId: string): Promise<NotifyMeOutcome> {
    const [product] = await this.db
      .select({ name: products.name, vendorId: products.vendor_id, shop: vendors.business_name })
      .from(products)
      .innerJoin(vendors, eq(vendors.id, products.vendor_id))
      .where(and(eq(products.id, productId), inVisibleCategory(products.category_id)));
    if (product === undefined) return { notified: 0 };
    return this.drain(
      { kind: 'BACK_IN_STOCK', productId },
      (tx) => takeBatch(tx, stockAlerts, stockAlerts.product_id, productId),
      (language) => backInStockText(language, product.name, product.shop),
      { kind: 'BACK_IN_STOCK', product_id: productId, vendor_id: product.vendorId },
    );
  }

  /**
   * `vendor.opened`, or the sweep: everyone waiting for the shop, if it takes orders now (LIVE,
   * its delivery mode on, open by its hours / switch, not paused). Still closed: nobody is told.
   */
  async shopOpened(vendorId: string): Promise<NotifyMeOutcome> {
    const [shop] = await this.db
      .select({ name: vendors.business_name })
      .from(vendors)
      .where(and(eq(vendors.id, vendorId), orderableShop()));
    if (shop === undefined) return { notified: 0 };
    return this.drain(
      { kind: 'SHOP_OPEN', vendorId },
      (tx) => takeBatch(tx, shopOpenAlerts, shopOpenAlerts.vendor_id, vendorId),
      (language) => shopOpenText(language, shop.name),
      { kind: 'SHOP_OPEN', vendor_id: vendorId },
    );
  }

  /**
   * Every 5 minutes on the maintenance queue. Opening by the clock writes nothing, so this is how
   * a shop opening by its hours tells its customers; it also catches a product whose stock came
   * back another way (a cancelled order's items returned), and one whose hidden category was shown
   * again (2026-10-20: a product under a hidden category waits here, its requests kept).
   */
  async sweep(): Promise<NotifyMeSweepSummary> {
    const readyProducts = await this.db
      .selectDistinct({ id: stockAlerts.product_id })
      .from(stockAlerts)
      .innerJoin(products, eq(products.id, stockAlerts.product_id))
      .where(
        and(
          eq(products.is_active, true),
          gt(products.stock_quantity, 0),
          inVisibleCategory(products.category_id),
        ),
      );
    const readyShops = await this.db
      .selectDistinct({ id: shopOpenAlerts.vendor_id })
      .from(shopOpenAlerts)
      .innerJoin(vendors, eq(vendors.id, shopOpenAlerts.vendor_id))
      .where(orderableShop());
    let notified = 0;
    for (const { id } of readyProducts) notified += (await this.productBackInStock(id)).notified;
    for (const { id } of readyShops) notified += (await this.shopOpened(id)).notified;
    return { products: readyProducts.length, shops: readyShops.length, notified };
  }

  private async drain(
    subject: NoticeSubject,
    take: (tx: Transaction) => Promise<string[]>,
    textOf: (language: LanguagePreference) => NoticeText,
    data: Record<string, unknown>,
  ): Promise<NotifyMeOutcome> {
    let notified = 0;
    for (;;) {
      const batch = await this.db.transaction(async (tx) => {
        const userIds = await take(tx);
        if (userIds.length === 0) return [];
        const byLanguage = await languagesOf(tx, userIds);
        for (const [language, ids] of byLanguage) {
          const text = textOf(language);
          await recordNotificationMessage(tx, {
            audience: 'CUSTOMER',
            source: 'SYSTEM',
            title: text.title,
            body: text.body,
            data,
            recipientUserIds: ids,
          });
        }
        return [...byLanguage];
      });
      if (batch.length === 0) break;
      for (const [language, ids] of batch) {
        notified += ids.length;
        await this.sendPush(ids, textOf(language), data, subject);
      }
    }
    return { notified };
  }

  private async sendPush(
    userIds: readonly string[],
    text: NoticeText,
    data: Record<string, unknown>,
    subject: NoticeSubject,
  ): Promise<void> {
    const tokens = await this.db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(inArray(deviceTokens.user_id, [...userIds]));
    if (tokens.length === 0) return;
    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      title: text.title,
      body: text.body,
      sound: 'default',
      priority: 'default',
      data,
    }));
    let tickets: PushTicket[];
    try {
      tickets = await this.push.send(messages);
    } catch (error: unknown) {
      // The notice is already in the notification centre; a failed push is not retried.
      console.error(
        JSON.stringify({
          notification: 'notify_me.push_failed',
          subject: subject.kind,
          recipients: userIds.length,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    const unregistered = tickets.flatMap((ticket) =>
      ticket.status === 'error' && ticket.error === EXPO_DEVICE_NOT_REGISTERED
        ? [ticket.token]
        : [],
    );
    if (unregistered.length > 0) {
      await this.db.delete(deviceTokens).where(inArray(deviceTokens.token, unregistered));
    }
  }
}

/** LIVE, delivery mode switched on by the Super Admin, and open now (hours, switch, no pause). */
function orderableShop(): SQL {
  // Qualified by hand, as in vendorClosedReason: Drizzle prints a bare column in a one-table select.
  const mode = sql.raw('"vendors"."fulfillment_mode"');
  return sql`(${vendors.status} = 'LIVE'
    AND ${vendorClosedReason()} IS NULL
    AND (SELECT CASE ${mode}
                  WHEN 'SELF_DELIVERY' THEN ps.self_delivery_enabled
                  ELSE ps.platform_fleet_enabled
                END
           FROM platform_settings ps))`;
}

/** Deletes up to one batch of requests for the subject and returns whose they were. */
async function takeBatch(
  tx: Transaction,
  table: typeof stockAlerts | typeof shopOpenAlerts,
  column: typeof stockAlerts.product_id | typeof shopOpenAlerts.vendor_id,
  subjectId: string,
): Promise<string[]> {
  const { rows } = await tx.execute<{ user_id: string }>(sql`
    DELETE FROM ${table}
     WHERE (user_id, ${sql.identifier(column.name)}) IN (
       SELECT user_id, ${sql.identifier(column.name)} FROM ${table}
        WHERE ${sql.identifier(column.name)} = ${subjectId}
        ORDER BY created_at, user_id
        LIMIT ${ALERT_NOTICE_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED)
    RETURNING user_id`);
  return rows.map((row) => row.user_id);
}

async function languagesOf(
  tx: Transaction,
  userIds: readonly string[],
): Promise<Map<LanguagePreference, string[]>> {
  const rows = await tx
    .select({ id: users.id, language: users.language_preference })
    .from(users)
    .where(inArray(users.id, [...userIds]));
  const byLanguage = new Map<LanguagePreference, string[]>();
  for (const row of rows) {
    byLanguage.set(row.language, [...(byLanguage.get(row.language) ?? []), row.id]);
  }
  return byLanguage;
}

export function backInStockText(
  language: LanguagePreference,
  product: string,
  shop: string,
): NoticeText {
  return language === 'ne'
    ? { title: 'फेरि उपलब्ध छ', body: `${shop} मा ${product} फेरि उपलब्ध छ।` }
    : { title: 'Back in stock', body: `${product} is back in stock at ${shop}.` };
}

export function shopOpenText(language: LanguagePreference, shop: string): NoticeText {
  return language === 'ne'
    ? { title: 'पसल खुल्यो', body: `${shop} अहिले खुला छ र अर्डर लिँदैछ।` }
    : { title: 'Shop open', body: `${shop} is open and taking orders now.` };
}

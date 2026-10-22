import { deviceTokens, users, vendors, type Database } from '@hamro-pasal/db';
import { eq, inArray } from 'drizzle-orm';

/** Where one side of an order is reached: its devices, and the number an SMS would go to. */
export interface PushRecipient {
  readonly userId: string;
  /** +977 number: the customer's own, or the shop's business number. */
  readonly phone: string;
  /** Expo push tokens of every device the account is signed in on; may be empty. */
  readonly tokens: readonly string[];
  /** 2026-10-22: those of `tokens` registered from an iPhone (they get the alarm as a visible push). */
  readonly iosTokens?: readonly string[];
}

export interface PushRecipientReader {
  /** null when no such user exists. */
  customer(userId: string): Promise<PushRecipient | null>;
  /** The vendor's own user (vendors.user_id); null when no such vendor exists. */
  vendor(vendorId: string): Promise<PushRecipient | null>;
}

/** Forgets tokens the push service reported as no longer registered. */
export interface DeviceTokenRemover {
  remove(tokens: readonly string[]): Promise<void>;
}

export class DatabasePushRecipients implements PushRecipientReader, DeviceTokenRemover {
  constructor(private readonly db: Database) {}

  async customer(userId: string): Promise<PushRecipient | null> {
    const [user] = await this.db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (user === undefined) return null;
    return { userId, phone: user.phone, ...(await this.devicesOf(userId)) };
  }

  async vendor(vendorId: string): Promise<PushRecipient | null> {
    const [vendor] = await this.db
      .select({ userId: vendors.user_id, phone: vendors.phone })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .limit(1);
    if (vendor === undefined) return null;
    return {
      userId: vendor.userId,
      phone: vendor.phone,
      ...(await this.devicesOf(vendor.userId)),
    };
  }

  async remove(tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.db.delete(deviceTokens).where(inArray(deviceTokens.token, [...tokens]));
  }

  private async devicesOf(userId: string): Promise<{ tokens: string[]; iosTokens: string[] }> {
    const rows = await this.db
      .select({ token: deviceTokens.token, platform: deviceTokens.platform })
      .from(deviceTokens)
      .where(eq(deviceTokens.user_id, userId))
      .orderBy(deviceTokens.created_at, deviceTokens.id);
    return {
      tokens: rows.map((row) => row.token),
      iosTokens: rows.filter((row) => row.platform === 'IOS').map((row) => row.token),
    };
  }
}

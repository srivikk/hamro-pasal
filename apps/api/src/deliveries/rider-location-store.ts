import { RIDER_LOCATION_MAX_AGE_SECONDS } from '@hamro-pasal/shared-types';

import type { RedisConnectionPool } from '../infra/redis-pool';

export const riderLocationKeys = {
  /** Redis geo set (GEOADD): member = rider user id, position = the rider's last report. */
  active: 'riders:active',
  /** Hash: rider user id → epoch ms of that report. GEOADD members carry no timestamp or TTL. */
  seen: 'riders:active:seen',
};

export interface RiderPosition {
  readonly latitude: number;
  readonly longitude: number;
}

export interface RiderLocation extends RiderPosition {
  readonly recordedAt: Date;
}

export interface RiderLocationStoreOptions {
  /** Tests only: a shorter staleness bound. Production uses RIDER_LOCATION_MAX_AGE_SECONDS. */
  readonly maxAgeMs?: number;
  readonly now?: () => Date;
}

/**
 * Where each rider was last seen (Phase 21), in Redis: a volatile, constantly overwritten value
 * that PostgreSQL has no business storing. `GEOADD riders:active <lng> <lat> <rider id>` keeps one
 * position per rider (and leaves the set ready for GEOSEARCH when gigs are broadcast by distance);
 * the report time sits beside it in a hash, written in the same MULTI, so a position is never
 * read without its age. A position older than the bound is treated as absent.
 */
export class RiderLocationStore {
  readonly maxAgeMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: RedisConnectionPool,
    options: RiderLocationStoreOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? RIDER_LOCATION_MAX_AGE_SECONDS * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /** Replaces the rider's position. Returns when it was recorded (this server's clock). */
  async record(riderId: string, position: RiderPosition): Promise<Date> {
    const recordedAt = this.now();
    await this.pool.withConnection(async (redis) => {
      const results = await redis
        .multi()
        // Redis takes longitude first.
        .geoadd(riderLocationKeys.active, position.longitude, position.latitude, riderId)
        .hset(riderLocationKeys.seen, riderId, String(recordedAt.getTime()))
        .exec();
      const failed = results?.find(([error]) => error !== null);
      if (results === null || failed !== undefined) {
        throw failed?.[0] ?? new Error('Rider location transaction was discarded');
      }
    });
    return recordedAt;
  }

  /** The fresh positions of these riders; a rider never seen, or seen too long ago, is left out. */
  async latest(riderIds: readonly string[]): Promise<Map<string, RiderLocation>> {
    const locations = new Map<string, RiderLocation>();
    if (riderIds.length === 0) return locations;
    const ids = [...new Set(riderIds)];
    const [positions, seen] = await this.pool.withConnection((redis) =>
      Promise.all([
        redis.geopos(riderLocationKeys.active, ...ids),
        redis.hmget(riderLocationKeys.seen, ...ids),
      ]),
    );
    const oldest = this.now().getTime() - this.maxAgeMs;
    ids.forEach((riderId, index) => {
      const position = positions[index];
      const seenAt = Number(seen[index] ?? Number.NaN);
      if (position === null || position === undefined || !(seenAt >= oldest)) return;
      locations.set(riderId, {
        longitude: Number(position[0]),
        latitude: Number(position[1]),
        recordedAt: new Date(seenAt),
      });
    });
    return locations;
  }

  /** Forgets a rider (both keys). */
  async remove(riderId: string): Promise<void> {
    await this.pool.withConnection(async (redis) => {
      await redis
        .multi()
        .zrem(riderLocationKeys.active, riderId)
        .hdel(riderLocationKeys.seen, riderId)
        .exec();
    });
  }
}

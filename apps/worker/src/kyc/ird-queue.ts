import { vendors, type Database } from '@hamro-pasal/db';
import {
  irdPanCheckJobSchema,
  JOB_QUEUES,
  type IrdPanCheckJob,
  type ServerEnv,
} from '@hamro-pasal/shared-types';
import { Queue, type ConnectionOptions, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';

import type { IrdPanLookup } from './ird-lookup';
import type { IrdPanVerificationService } from './ird-pan-verification';
import { MockIrdLookup } from './mock-ird-lookup';
import { PlaywrightIrdLookup } from './playwright-ird-lookup';
import { ProxyRotation } from './proxy-rotation';
import { TwoCaptchaSolver } from './two-captcha';

/*
 * The `ird-pan-verification` queue (2026-10-21): one job per requested IRD check. The Kafka
 * consumer of `vendor.pan_check_requested` adds it; the worker runs one check at a time, at most
 * one every IRD_RATE_LIMIT_MS, so the IRD's site sees a trickle, never a burst.
 */

/** One IRD lookup at a time, and at most one start every 10 s. */
export const IRD_RATE_LIMIT_MS = 10_000;

export function createIrdQueue(
  connection: ConnectionOptions,
  prefix?: string,
): Queue<IrdPanCheckJob> {
  return new Queue<IrdPanCheckJob>(
    JOB_QUEUES.IRD_PAN_VERIFICATION,
    prefix === undefined ? { connection } : { connection, prefix },
  );
}

export interface IrdCheckScheduler {
  schedule(checkId: string, requestedAt: string): Promise<void>;
}

/**
 * The job id is the check and the time it was requested: a redelivered event adds nothing, while a
 * Super Admin's retry (same check, a new request) is a job of its own. The state machine retries
 * inside one job (3 attempts); BullMQ's 2 attempts only cover the job itself failing (the database
 * down), and the state machine's claim makes a repeat harmless.
 */
export function bullIrdCheckScheduler(queue: Queue<IrdPanCheckJob>): IrdCheckScheduler {
  return {
    schedule: async (checkId, requestedAt) => {
      await queue.add(
        'ird-pan-check',
        { check_id: checkId },
        {
          jobId: `ird-${checkId}-${String(Date.parse(requestedAt))}`,
          attempts: 2,
          backoff: { type: 'fixed', delay: 60_000 },
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      );
    },
  };
}

export function createIrdProcessor(service: Pick<IrdPanVerificationService, 'run'>) {
  return async (job: Job): Promise<void> => {
    const { check_id: checkId } = irdPanCheckJobSchema.parse(job.data);
    const outcome = await service.run(checkId);
    console.info(JSON.stringify({ ird_check: 'done', check_id: checkId, ...outcome }));
  };
}

/** The lookup IRD_VERIFICATION_PROVIDER asks for; null when DISABLED. */
export function irdLookupFromEnv(env: ServerEnv, db: Database): IrdPanLookup | null {
  switch (env.IRD_VERIFICATION_PROVIDER) {
    case 'DISABLED':
      return null;
    case 'MOCK':
      // The mock "IRD" knows each vendor by its own legal (else business) name.
      return new MockIrdLookup(async (pan) => {
        const [vendor] = await db
          .select({ legal: vendors.legal_name, business: vendors.business_name })
          .from(vendors)
          .where(eq(vendors.tax_id, pan))
          .limit(1);
        return vendor === undefined ? null : (vendor.legal ?? vendor.business);
      });
    case 'PLAYWRIGHT': {
      const apiKey = env.TWOCAPTCHA_API_KEY;
      if (apiKey === undefined) throw new Error('TWOCAPTCHA_API_KEY is required for PLAYWRIGHT');
      return new PlaywrightIrdLookup({
        searchUrl: env.IRD_PAN_SEARCH_URL,
        solver: new TwoCaptchaSolver({ apiKey }),
        proxies: new ProxyRotation(env.IRD_PROXY_URLS),
        ...(env.IRD_CHROMIUM_PATH === undefined ? {} : { executablePath: env.IRD_CHROMIUM_PATH }),
      });
    }
  }
}

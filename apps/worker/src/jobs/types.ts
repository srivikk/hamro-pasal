import type { Job } from 'bullmq';

export interface ScheduledJobDefinition {
  /** Used as both the BullMQ queue name and the job scheduler id. */
  readonly name: string;
  /** Cron expression, evaluated in `timezone`. */
  readonly cron: string;
  readonly timezone: string;
  readonly process: (job: Job) => Promise<void>;
}

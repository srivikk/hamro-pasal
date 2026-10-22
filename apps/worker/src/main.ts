import { resolve } from 'node:path';

import { mailGatewayFromEnv } from '@hamro-pasal/mail';
import { privateObjectStoreFromEnv } from '@hamro-pasal/storage';
import { BillingCycleRenewalService } from './billing/billing-cycle-renewal';
import { CycleDuesSweepService } from './billing/cycle-dues-sweep';
import { ComplianceSweepService } from './compliance/compliance-sweep';
import { SettlementPayoutRunService } from './finance/settlement-payout-run';
import { MarketingStatusSweepService } from './marketing/marketing-status-sweep';
import { createDatabase } from '@hamro-pasal/db';
import { ivrGatewayFromEnv } from '@hamro-pasal/ivr';
import { createIdempotentProducer, createKafka, DomainEventPublisher } from '@hamro-pasal/kafka';
import { LedgerService, SettlementService, WalletService } from '@hamro-pasal/ledger';
import { smsGatewayFromEnv } from '@hamro-pasal/sms';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { loadEnvOrExit } from './config/env';
import { buildConsumers, routeByTopic } from './consumers';
import { KafkaDeadLetterPublisher } from './consumers/dead-letter';
import { smsFallbackLogFromEnv } from './consumers/order-push-notifications';
import { DeadLetterReplayer } from './dead-letters/dead-letter-replayer';
import { DatabaseDeadLetterStore } from './dead-letters/dead-letter-store';
import { OrderReconciliationService } from './finance/order-reconciliation';
import { BullVendorAcceptanceTimers } from './consumers/vendor-sla-scheduler';
import { buildBullConnection } from './infra/redis';
import { startHealthServer } from './health/health-server';
import { Lifecycle } from './lifecycle';
import { DatabaseNoticeInbox, InboxNotificationAdapter } from './notifications/notice-inbox';
import { notificationAdapterFromEnv } from './notifications/production-notification-adapter';
import { DatabaseOrderStateReader } from './notifications/order-state-reader';
import { DatabaseVendorContacts } from './notifications/vendor-notices';
import { DatabaseOrderInbox } from './notifications/order-inbox';
import { DatabasePushRecipients } from './notifications/push-recipients';
import { mockPushLogFromEnv, pushGatewayFromEnv } from './push/mock-push';
import { OutboxRelay } from './outbox/outbox-relay';
import {
  allTimerQueues,
  createTimerQueues,
  queueComplianceSweepNow,
  registerMidnightJobs,
  scheduleDataExport,
} from './queues/definitions';
import { createExportProcessor, createProcessors, createTimerHandlers } from './queues/processors';
import { ExportJobService } from './exports/export-job';
import { AuthEventsPruneService } from './auth/auth-events-prune';
import { IrdPanVerificationService } from './kyc/ird-pan-verification';
import {
  bullIrdCheckScheduler,
  createIrdProcessor,
  createIrdQueue,
  irdLookupFromEnv,
  IRD_RATE_LIMIT_MS,
} from './kyc/ird-queue';
import { DisputeHoldReleaseService } from './finance/dispute-hold-release';
import { AdminPushService } from './notifications/admin-push';
import { DisputeNoticeService } from './notifications/dispute-notices';
import { NotifyMeService } from './notifications/notify-me';
import { VendorAcceptanceExpiryService } from './sla/vendor-acceptance-expiry';
import { VendorEscalationService } from './sla/vendor-escalation';
import { VendorDebtReconciliationService } from './wallet/vendor-debt-reconciliation';

async function main(): Promise<void> {
  const env = loadEnvOrExit('worker');
  const lifecycle = new Lifecycle();

  // PostgreSQL (outbox) -> Kafka (idempotent producer)
  const db = createDatabase(env.DATABASE_URL);
  lifecycle.register(() => db.$client.end());
  const kafka = createKafka(env);
  const producer = createIdempotentProducer(kafka);
  await producer.connect();
  lifecycle.register(() => producer.disconnect());
  const relay = new OutboxRelay(db, new DomainEventPublisher(producer));
  relay.start();
  lifecycle.register(() => relay.stop());
  // Dead letters a Super Admin asked to retry (POST /api/admin/dlq/:id/retry) go back to their
  // source topic through the same idempotent producer (Phase 15).
  const deadLetterPublisher = new KafkaDeadLetterPublisher(producer);
  const replayer = new DeadLetterReplayer(db, deadLetterPublisher);
  replayer.start();
  lifecycle.register(() => replayer.stop());

  // Pushes go to https://exp.host/--/api/v2/push/send for every registered device.
  // MOCK_SERVICES=true: no request is made and each order push is logged as "[MOCK PUSH] -> …".
  const push = pushGatewayFromEnv(env);
  // Step 7.4: Notify Me, from its outbox events and from the 5-minute sweep.
  const notifyMe = new NotifyMeService(db, push);

  // The API's private uploads directory (development): the worker writes, the API serves.
  const DEFAULT_PRIVATE_UPLOADS_DIR = resolve(__dirname, '..', '..', 'api', 'uploads-private');
  // Step 7.6: queued data exports, emailed through MAIL_PROVIDER (Amazon SES over SMTP) and, when
  // too large to attach, stored in the private store for a link.
  const exportJobsService = new ExportJobService({
    db,
    mail: mailGatewayFromEnv(env),
    files: privateObjectStoreFromEnv(env, DEFAULT_PRIVATE_UPLOADS_DIR),
    apiBaseUrl: env.PUBLIC_API_BASE_URL ?? `http://localhost:${String(env.API_PORT)}`,
  });

  // BullMQ timers and crons
  const connection = buildBullConnection(env.REDIS_URL);
  const queues = createTimerQueues(connection);
  await registerMidnightJobs(queues.midnight);
  await queueComplianceSweepNow(queues.midnight);
  const reconciliationLedger = new LedgerService(new WalletService());
  const processors = createProcessors(
    createTimerHandlers({
      escalation: new VendorEscalationService(db),
      acceptanceExpiry: new VendorAcceptanceExpiryService(
        db,
        new LedgerService(new WalletService()),
      ),
      notifyMe,
      exports: exportJobsService,
      // 2026-10-22 (Task 6): Authentication Log rows older than 30 days.
      authEventsPrune: new AuthEventsPruneService(db),
      // Step 7.3: day 8, the held prepaid earnings of an order nobody escalated.
      disputeHoldRelease: new DisputeHoldReleaseService(db, new LedgerService(new WalletService())),
      debtReconciliation: new VendorDebtReconciliationService(db),
      complianceSweep: new ComplianceSweepService(db),
      billingRenewal: new BillingCycleRenewalService(db),
      cycleDues: new CycleDuesSweepService(db),
      marketingSweep: new MarketingStatusSweepService(db, new LedgerService(new WalletService())),
      settlementPayoutRun: new SettlementPayoutRunService(
        db,
        new LedgerService(new WalletService()),
      ),
      // Phase 22: verifies (and, if missing, posts) the settlement of every DELIVERED order.
      orderReconciliation: new OrderReconciliationService(
        db,
        new SettlementService(db, reconciliationLedger),
        reconciliationLedger,
      ),
    }),
  );
  const workers = [
    new Worker(queues.vendorAcceptance.name, processors.vendorAcceptance, { connection }),
    new Worker(queues.ghostCustomer.name, processors.ghostCustomer, { connection }),
    new Worker(queues.midnight.name, processors.midnight, { connection }),
    // Step 7.6: two exports at a time at most; each streams from the database.
    new Worker(queues.dataExport.name, createExportProcessor(exportJobsService), {
      connection,
      concurrency: 2,
    }),
  ];
  // 2026-10-21: the automated IRD PAN check. IRD_VERIFICATION_PROVIDER=PLAYWRIGHT drives the IRD's
  // public PAN search in headless Chromium (2Captcha for its reCAPTCHA, IRD_PROXY_URLS in turn);
  // MOCK answers locally; DISABLED sends every check to the admin's manual review. One check at a
  // time, at most one start every 10 s.
  const irdQueue = createIrdQueue(connection);
  lifecycle.register(() => irdQueue.close());
  const irdLookup = irdLookupFromEnv(env, db);
  if (irdLookup !== null) lifecycle.register(() => irdLookup.close());
  workers.push(
    new Worker(
      irdQueue.name,
      createIrdProcessor(new IrdPanVerificationService({ db, lookup: irdLookup })),
      { connection, concurrency: 1, limiter: { max: 1, duration: IRD_RATE_LIMIT_MS } },
    ),
  );
  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      console.error(`[worker] ${worker.name} job ${job?.id ?? '?'} failed`, error);
    });
    lifecycle.register(() => worker.close());
  }
  for (const queue of allTimerQueues(queues)) {
    lifecycle.register(() => queue.close());
  }

  // Kafka consumers: order state fan-out to the API's Socket.io rooms through Redis, the 90 s
  // vendor acceptance timer for every order that becomes PLACED, Expo pushes for order state
  // changes (best effort), and vendor SMS for
  // notifications.broadcast (suspension, restore, SLA escalation + IVR call; failures go to
  // notifications.dlq after 3 retries).
  const redis = new Redis(env.REDIS_URL);
  lifecycle.register(async () => {
    await redis.quit();
  });
  // SMS_PROVIDER=MOCK logs "[sms:mock] to +977…: <text>" instead of calling the provider.
  const sms = smsGatewayFromEnv(env);
  const pushRecipients = new DatabasePushRecipients(db);
  const consumers = buildConsumers({
    redis,
    vendorAcceptanceTimers: new BullVendorAcceptanceTimers(queues.vendorAcceptance),
    sms,
    // IVR_PROVIDER=MOCK logs "[ivr:mock] Calling +977…" for escalations; DISABLED places no call.
    ivr: ivrGatewayFromEnv(env),
    orders: new DatabaseOrderStateReader(db),
    deadLetters: deadLetterPublisher,
    deadLetterStore: new DatabaseDeadLetterStore(db),
    push,
    pushMockLog: mockPushLogFromEnv(env),
    pushRecipients,
    orderInbox: new DatabaseOrderInbox(db),
    // SMS_PROVIDER=MOCK also logs "[sms:mock] to +977…: <text>" beside each push attempt.
    pushSmsFallbackLog: smsFallbackLogFromEnv(env),
    // Compliance, account, ad and campaign notices: an SMS through SMS_PROVIDER, then a push to
    // the shop's devices (Phase 38). MOCK_SERVICES=true writes "[notify:sms] …" and
    // "[notify:push] …" lines instead and sends nothing.
    // Step 7.1: each notice is first kept in the shop's notification centre.
    notifications: new InboxNotificationAdapter(
      new DatabaseNoticeInbox(db),
      notificationAdapterFromEnv(env, { sms, push, recipients: pushRecipients }),
    ),
    vendorContacts: new DatabaseVendorContacts(db),
    notifyMe,
    // Step 7.3: the parties of an escalated or resolved order are told.
    disputeNotices: new DisputeNoticeService(db, push),
    // Step 7.5: the Super Admin's messages reach the devices.
    adminPush: new AdminPushService(db, push),
    dataExports: { schedule: (jobId) => scheduleDataExport(queues.dataExport, jobId) },
    irdChecks: bullIrdCheckScheduler(irdQueue),
  });
  if (consumers.length > 0) {
    const handlers = routeByTopic(consumers);
    const consumer = kafka.consumer({ kafkaJS: { groupId: env.KAFKA_CONSUMER_GROUP_ID } });
    await consumer.connect();
    lifecycle.register(() => consumer.disconnect());
    await consumer.subscribe({ topics: [...handlers.keys()] });
    await consumer.run({
      eachMessage: async (payload) => {
        const handle = handlers.get(payload.topic);
        if (handle === undefined) {
          throw new Error(`No handler registered for topic "${payload.topic}"`);
        }
        await handle(payload);
      },
    });
  }

  console.info(
    `[worker] started: outbox relay, dead-letter replayer, ${String(workers.length)} BullMQ workers, ${String(consumers.length)} Kafka consumer(s)`,
  );

  // Task 8: GET /health for the orchestrator, started last (200 means everything above is running).
  // On shutdown it answers 503 at once and stays up while the consumers drain, then closes last.
  const health = await startHealthServer({
    port: env.WORKER_HEALTH_PORT,
    host: env.WORKER_HEALTH_HOST,
  });
  console.info(
    `[worker] health check on http://${env.WORKER_HEALTH_HOST}:${String(health.port)}/health`,
  );

  const shutdown = (signal: NodeJS.Signals): void => {
    console.info(`[worker] ${signal} received, shutting down`);
    health.markStopping();
    lifecycle
      .close()
      .finally(() => health.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

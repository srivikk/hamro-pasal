#!/usr/bin/env node
/*
 * pnpm dev:reset --yes [--minimal]
 *
 * Wipes the LOCAL DEVELOPMENT state for an end-to-end run from scratch, then rebuilds the schema
 * and the seed. Only the dev side is touched: the `kafka` broker (never `kafka-test`), the
 * database named in DATABASE_URL (never the *_test ones), and REDIS_URL's database index (never
 * the integration tests' 14 / 15).
 *
 *   1. Kafka (dev broker): deletes every consumer group, deletes the topics of
 *      infra/kafka/create-topics.sh (notifications.dlq included), waits until they are gone and
 *      recreates them empty (kafka-init).
 *   2. Redis: FLUSHDB of REDIS_URL's database (sessions, OTP state, inventory locks, rate limits,
 *      BullMQ queues and schedules). The worker re-registers its schedules when it starts.
 *   3. PostgreSQL: DROP DATABASE ... WITH (FORCE), CREATE DATABASE, then every migration
 *      (pnpm db:migrate). The outbox, dead letters and audit log are rows: they go with it. The
 *      platform_settings row is created by migration 0002.
 *   4. Seed: `pnpm db:seed` (the Super Admin +9779800000099, demo customers, shops, products and
 *      the category taxonomy). With --minimal, only the Super Admin account, for a test that starts
 *      from an empty marketplace.
 *
 * Every account signs in by OTP; with SMS_PROVIDER=MOCK the code is printed in the API log.
 *
 * Refuses unless --yes is given, when NODE_ENV is production, when DATABASE_URL is not a local
 * database, and while the API answers on API_PORT (stop `pnpm dev` first: running services would
 * hold connections, recreate topics half-way and write to the old state).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPER_ADMIN_PHONE = '+9779800000099';
const DEV_TOPICS = [
  'order.lifecycle',
  'payment.reconciliation',
  'ledger.mutations',
  'notifications.broadcast',
  'notifications.dlq',
];
const KAFKA_BIN = '/opt/kafka/bin';
const KAFKA_BOOTSTRAP = 'localhost:29092';

const args = new Set(process.argv.slice(2));
const minimal = args.has('--minimal');

function fail(message) {
  console.error(`\n[dev:reset] ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n[dev:reset] ${message}`);
}

/** Runs a command from the repo root; output streams through. Returns stdout when captured. */
function run(command, commandArgs, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32' && command === 'pnpm',
    // Git Bash would rewrite the container paths (/opt/kafka/...) into Windows paths otherwise.
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });
  if (result.error !== undefined) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(`${command} ${commandArgs.join(' ')} exited with ${String(result.status)}`);
  }
  return capture ? result.stdout : '';
}

const compose = (service, command, options) =>
  run('docker', ['compose', 'exec', '-T', service, ...command], options);

function apiIsUp(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------
const envFile = path.join(ROOT, '.env');
if (!existsSync(envFile)) fail('No .env at the repo root (copy .env.example first).');
process.loadEnvFile(envFile);

if (process.env.NODE_ENV === 'production') fail('Refusing: NODE_ENV is production.');

const databaseUrl = new URL(process.env.DATABASE_URL ?? fail('DATABASE_URL is not set.'));
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname)) {
  fail(`Refusing: DATABASE_URL points at ${databaseUrl.hostname}, not a local database.`);
}
const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ''));
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) fail(`Unexpected database name "${databaseName}".`);
if (databaseName.endsWith('_test')) fail('Refusing: that is a test database.');
const databaseUser = decodeURIComponent(databaseUrl.username);

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
const redisDb = redisUrl.pathname.replace(/^\//, '') || '0';
if (!/^\d+$/.test(redisDb)) fail(`Unexpected Redis database "${redisDb}".`);
if (['14', '15'].includes(redisDb)) fail('Refusing: REDIS_URL names an integration-test database.');

const plan = [
  `Kafka (dev broker "kafka" only): delete consumer groups and topics ${DEV_TOPICS.join(', ')}, recreate them empty`,
  `Redis: FLUSHDB of database ${redisDb}`,
  `PostgreSQL: drop and recreate "${databaseName}", run every migration`,
  minimal
    ? `Seed: only the Super Admin ${SUPER_ADMIN_PHONE}`
    : `Seed: pnpm db:seed (Super Admin ${SUPER_ADMIN_PHONE}, demo customers, shops, products, categories)`,
];
console.log('[dev:reset] This wipes your local development state:');
for (const line of plan) console.log(`  - ${line}`);
if (!args.has('--yes')) {
  fail('Nothing was changed. Run again with --yes to go ahead:  pnpm dev:reset --yes');
}

const apiPort = Number(process.env.API_PORT ?? 4000);
if (await apiIsUp(apiPort)) {
  fail(`The API is running on port ${String(apiPort)}. Stop \`pnpm dev\` (API, worker) first.`);
}

// ---------------------------------------------------------------------------------------------
// 1. Kafka
// ---------------------------------------------------------------------------------------------
step('Kafka: removing consumer groups');
const groups = compose(
  'kafka',
  [`${KAFKA_BIN}/kafka-consumer-groups.sh`, '--bootstrap-server', KAFKA_BOOTSTRAP, '--list'],
  { capture: true },
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');
// One call for all of them: the tool takes --group once per group.
if (groups.length > 0) {
  compose('kafka', [
    `${KAFKA_BIN}/kafka-consumer-groups.sh`,
    '--bootstrap-server',
    KAFKA_BOOTSTRAP,
    '--delete',
    ...groups.flatMap((group) => ['--group', group]),
  ]);
}
console.log(`  ${String(groups.length)} group(s) removed`);

const listTopics = () =>
  compose(
    'kafka',
    [`${KAFKA_BIN}/kafka-topics.sh`, '--bootstrap-server', KAFKA_BOOTSTRAP, '--list'],
    {
      capture: true,
    },
  )
    .split('\n')
    .map((line) => line.trim());

step('Kafka: deleting the topics');
const present = listTopics().filter((topic) => DEV_TOPICS.includes(topic));
for (const topic of present) {
  compose('kafka', [
    `${KAFKA_BIN}/kafka-topics.sh`,
    '--bootstrap-server',
    KAFKA_BOOTSTRAP,
    '--delete',
    '--topic',
    topic,
  ]);
}
// Deletion is asynchronous: recreating too early answers "marked for deletion".
for (let attempt = 0; ; attempt += 1) {
  const left = listTopics().filter((topic) => DEV_TOPICS.includes(topic));
  if (left.length === 0) break;
  if (attempt === 30) fail(`Kafka is still deleting ${left.join(', ')}; run pnpm dev:reset again.`);
  await sleep(1000);
}

step('Kafka: recreating the topics empty');
run('docker', ['compose', 'run', '--rm', 'kafka-init']);

// ---------------------------------------------------------------------------------------------
// 2. Redis
// ---------------------------------------------------------------------------------------------
step(`Redis: flushing database ${redisDb}`);
compose('redis', ['redis-cli', '-n', redisDb, 'FLUSHDB']);

// ---------------------------------------------------------------------------------------------
// 3. PostgreSQL
// ---------------------------------------------------------------------------------------------
step(`PostgreSQL: dropping and recreating "${databaseName}"`);
const psql = (sql) =>
  compose('postgres', [
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    databaseUser,
    '-d',
    'postgres',
    '-c',
    sql,
  ]);
psql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
psql(`CREATE DATABASE "${databaseName}"`);

step('PostgreSQL: running every migration');
run('pnpm', ['--filter', '@hamro-pasal/db', 'db:migrate']);

// ---------------------------------------------------------------------------------------------
// 4. Seed
// ---------------------------------------------------------------------------------------------
if (minimal) {
  step(`Seed: the Super Admin ${SUPER_ADMIN_PHONE} only`);
  // users.role is mirrored into user_roles by a trigger (migration 0045).
  compose('postgres', [
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    databaseUser,
    '-d',
    databaseName,
    '-c',
    `INSERT INTO users (phone, role, first_name) VALUES ('${SUPER_ADMIN_PHONE}', 'SUPER_ADMIN', 'Platform')`,
  ]);
} else {
  step('Seed: pnpm db:seed');
  run('pnpm', ['--filter', '@hamro-pasal/db', 'db:seed']);
}

console.log(`
[dev:reset] Done. Start the stack again with:
  pnpm turbo run dev --filter=@hamro-pasal/api --filter=@hamro-pasal/worker --filter=@hamro-pasal/admin
Sign in to the Admin dashboard with ${SUPER_ADMIN_PHONE}; the OTP is printed in the API log
(SMS_PROVIDER=MOCK). In the apps, clear stored sessions (sign out, or reinstall the dev build):
a token issued before the reset names an account that no longer exists.`);

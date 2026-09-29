/**
 * Integration tests against real Redis (BullMQ, logical DB 14), PostgreSQL (hamro_pasal_worker_test)
 * and Kafka (pnpm infra:up).
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.int.test.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 60000,
};

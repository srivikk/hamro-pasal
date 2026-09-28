/**
 * Integration tests against a real PostgreSQL + PostGIS server (pnpm infra:up).
 * globalSetup drops and recreates a dedicated test database and applies every migration.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.int.test.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
};

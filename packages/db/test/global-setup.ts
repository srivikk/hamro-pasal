import { prepareTestDatabase } from '../src/testing';

export default async function globalSetup(): Promise<void> {
  process.env.TEST_DATABASE_URL = await prepareTestDatabase('test');
}

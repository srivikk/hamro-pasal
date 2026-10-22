import { InvalidEnvError } from '@hamro-pasal/shared-types';

import { loadEnv, loadEnvOrExit } from './env';

describe('loadEnv', () => {
  it('fails fast when required variables are missing', () => {
    expect(() => loadEnv({})).toThrow(InvalidEnvError);
  });
});

describe('loadEnvOrExit (Phase 7)', () => {
  class Exited extends Error {
    constructor(readonly code: number) {
      super(`exit ${String(code)}`);
    }
  }
  const exit = (code: number): never => {
    throw new Exited(code);
  };

  it('stops with exit code 1 and names the problems, never a value', () => {
    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(line);
    });
    try {
      expect(() =>
        loadEnvOrExit('api', { JWT_ACCESS_SECRET: 'super-secret-value-that-must-not-leak' }, exit),
      ).toThrow(new Exited(1));
    } finally {
      spy.mockRestore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^\[api\] refusing to start\. Invalid environment configuration/);
    expect(errors[0]).toContain('DATABASE_URL');
    expect(errors[0]).not.toContain('super-secret-value-that-must-not-leak');
  });
});

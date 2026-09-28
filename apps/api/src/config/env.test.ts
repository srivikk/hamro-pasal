import { InvalidEnvError } from '@hamro-pasal/shared-types';

import { loadEnv } from './env';

describe('loadEnv', () => {
  it('fails fast when required variables are missing', () => {
    expect(() => loadEnv({})).toThrow(InvalidEnvError);
  });
});

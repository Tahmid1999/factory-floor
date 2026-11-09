import { assertProductionSecrets } from './secrets';

const long = 'x'.repeat(32);
const good = { ADMIN_JWT_SECRET: long, COOKIE_SECRET: long, SIM_KEY: long };

describe('assertProductionSecrets', () => {
  it('accepts three secrets of 32 characters in production', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'production', ...good })).not.toThrow();
  });

  it('names a secret that is missing', () => {
    const { SIM_KEY, ...rest } = good;
    expect(() => assertProductionSecrets({ NODE_ENV: 'production', ...rest })).toThrow(/SIM_KEY/);
  });

  it('names a secret that is one character short, and only that one', () => {
    const env = { NODE_ENV: 'production', ...good, COOKIE_SECRET: 'x'.repeat(31) };
    expect(() => assertProductionSecrets(env)).toThrow(/^COOKIE_SECRET must/);
  });

  it('names every weak secret at once', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'production' })).toThrow(
      /ADMIN_JWT_SECRET, COOKIE_SECRET, SIM_KEY/,
    );
  });

  it('lets development and test run on short secrets', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionSecrets({})).not.toThrow();
  });
});

import { assertSimTrustedAddr, isSimCaller } from './sim-caller';

const env = { SIM_KEY: 'k'.repeat(32), SIM_TRUSTED_ADDR: '10.241.2.10' };
const key = env.SIM_KEY;

describe('isSimCaller', () => {
  it('accepts the key from loopback, in either spelling', () => {
    expect(isSimCaller(key, '127.0.0.1', {}, env)).toBe(true);
    expect(isSimCaller(key, '::ffff:127.0.0.1', {}, env)).toBe(true);
    expect(isSimCaller(key, '::1', {}, env)).toBe(true);
  });

  it('accepts the key from the trusted worker address', () => {
    expect(isSimCaller(key, '10.241.2.10', {}, env)).toBe(true);
    expect(isSimCaller(key, '::ffff:10.241.2.10', {}, env)).toBe(true);
  });

  it('refuses the gateway even with the key', () => {
    expect(isSimCaller(key, '10.241.2.1', {}, env)).toBe(false);
  });

  it('refuses any x-forwarded-for, even from loopback or the worker', () => {
    expect(isSimCaller(key, '127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }, env)).toBe(false);
    expect(isSimCaller(key, '10.241.2.10', { 'x-forwarded-for': '' }, env)).toBe(false);
  });

  it('refuses a wrong or missing key', () => {
    expect(isSimCaller('nope', '127.0.0.1', {}, env)).toBe(false);
    expect(isSimCaller(undefined, '127.0.0.1', {}, env)).toBe(false);
    expect(isSimCaller(undefined, '127.0.0.1', {}, { SIM_KEY: undefined })).toBe(false);
  });

  it('trusts only loopback when no address is configured', () => {
    expect(isSimCaller(key, '10.241.2.10', {}, { SIM_KEY: key })).toBe(false);
  });
});

describe('assertSimTrustedAddr', () => {
  it('refuses the compose gateway', () => {
    expect(() => assertSimTrustedAddr({ SIM_TRUSTED_ADDR: '10.241.2.1' })).toThrow(/gateway/);
    expect(() => assertSimTrustedAddr({ SIM_TRUSTED_ADDR: '::ffff:10.241.2.1' })).toThrow(/gateway/);
  });

  it('accepts the worker address or none', () => {
    expect(() => assertSimTrustedAddr({ SIM_TRUSTED_ADDR: '10.241.2.10' })).not.toThrow();
    expect(() => assertSimTrustedAddr({})).not.toThrow();
  });
});

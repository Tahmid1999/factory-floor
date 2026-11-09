const NAMES = ['ADMIN_JWT_SECRET', 'COOKIE_SECRET', 'SIM_KEY'] as const;
const MIN_LENGTH = 32;

// A blank or short secret in production would still boot and sign cookies,
// so refuse to start instead of finding out from a forged one.
export function assertProductionSecrets(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== 'production') return;
  const weak = NAMES.filter((name) => (env[name] ?? '').length < MIN_LENGTH);
  if (weak.length > 0) {
    throw new Error(`${weak.join(', ')} must be set to at least ${MIN_LENGTH} characters in production`);
  }
}

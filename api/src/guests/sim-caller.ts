import type { IncomingHttpHeaders } from 'node:http';

// The address Caddy's traffic arrives from in production: the compose
// network's gateway. Trusting it would let any visitor pass the sim check.
const COMPOSE_GATEWAY = '10.241.2.1';

const bare = (addr: string) => addr.replace(/^::ffff:/, '');

function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.');
}

// Judged on the socket peer, never req.ip: req.ip follows X-Forwarded-For from
// any trusted proxy, so it can be made to say loopback by whoever can reach
// the proxy. The peer is the worker's own address (loopback in dev, the
// worker container's pinned address in production), and a request that came
// through a proxy carries X-Forwarded-For, which is refused outright.
export function isSimCaller(
  key: string | undefined,
  socketAddr: string | undefined,
  headers: IncomingHttpHeaders,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!key || !env.SIM_KEY || key !== env.SIM_KEY) return false;
  if (!socketAddr || headers['x-forwarded-for'] !== undefined) return false;
  const addr = bare(socketAddr);
  const trusted = env.SIM_TRUSTED_ADDR ? bare(env.SIM_TRUSTED_ADDR) : undefined;
  return isLoopback(addr) || addr === trusted;
}

// Caddy reaches the API from the gateway address, so naming the gateway as the
// sim's address would hand the sim key's powers to every visitor.
export function assertSimTrustedAddr(env: NodeJS.ProcessEnv): void {
  if (env.SIM_TRUSTED_ADDR && bare(env.SIM_TRUSTED_ADDR) === COMPOSE_GATEWAY) {
    throw new Error(`SIM_TRUSTED_ADDR must not be ${COMPOSE_GATEWAY}: that is the gateway Caddy's traffic arrives from`);
  }
}

// One API process, so memory is enough here; with two processes this moves to
// Postgres or Redis.
const windows = new Map<string, { start: number; ms: number; count: number }>();

// Every key is a device, an address or a guest, so a public API sees new ones
// all day. Windows that have run out are swept every so many calls, which
// keeps the map at about the keys of the last hour without a timer.
const SWEEP_EVERY = 1000;
let calls = 0;

function sweep(now: number): void {
  for (const [key, w] of windows) if (now - w.start >= w.ms) windows.delete(key);
}

export function hit(key: string, max: number, windowSec: number, now: number): boolean {
  if (++calls % SWEEP_EVERY === 0) sweep(now);
  const w = windows.get(key);
  if (!w || now - w.start >= w.ms) {
    windows.set(key, { start: now, ms: windowSec * 1000, count: 1 });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
}

// The per-device batch and gate limits, the two the sim runs into. A seed
// run (SEED_MODE=1) sends a sim-hour of scans in a few wall seconds, so
// there they would only throttle it; the api and worker refuse to boot with
// SEED_MODE=1, so the run is the only process where this is off. Every other
// limit stays on.
export function allow(key: string, max: number, windowSec: number, now: number): boolean {
  return process.env.SEED_MODE === '1' || hit(key, max, windowSec, now);
}

// Gives back a slot taken by hit(), for limits that count failures only: the
// caller takes the slot before any await so parallel tries cannot all pass the
// check, then refunds it when the try turns out to be fine.
export function refund(key: string): void {
  const w = windows.get(key);
  if (w && w.count > 0) w.count -= 1;
}

// The stress button opens 20 transactions at once and anyone may press it, so
// one address gets a run a minute and everyone together 20 an hour. The
// address goes first, so one address pressing again cannot spend the total.
export function stressRefusal(ip: string, now: number): string | null {
  if (!hit(`stress:${ip}`, 1, 60, now)) return 'one stress run a minute, try again shortly';
  if (!hit('stress:all', 20, 3600, now)) return 'stress runs are used up for this hour, try later';
  return null;
}

// For the spec: how many windows are held.
export function windowCount(): number {
  return windows.size;
}

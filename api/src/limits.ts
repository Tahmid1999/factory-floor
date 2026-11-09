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

// Gives back a slot taken by hit(), for limits that count failures only: the
// caller takes the slot before any await so parallel tries cannot all pass the
// check, then refunds it when the try turns out to be fine.
export function refund(key: string): void {
  const w = windows.get(key);
  if (w && w.count > 0) w.count -= 1;
}

// For the spec: how many windows are held.
export function windowCount(): number {
  return windows.size;
}

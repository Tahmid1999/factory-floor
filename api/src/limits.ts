// One API process, so memory is enough here; with two processes this moves to
// Postgres or Redis.
const windows = new Map<string, { start: number; count: number }>();

export function hit(key: string, max: number, windowSec: number, now: number): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= windowSec * 1000) {
    windows.set(key, { start: now, count: 1 });
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

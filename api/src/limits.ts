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

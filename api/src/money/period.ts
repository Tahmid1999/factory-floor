// A period is a UTC calendar month, 'YYYY-MM'.
export function periodOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function nextPeriod(p: string): string {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// end is exclusive: the first instant of the next month.
export function periodBounds(p: string): { start: Date; end: Date } {
  return { start: new Date(`${p}-01T00:00:00Z`), end: new Date(`${nextPeriod(p)}-01T00:00:00Z`) };
}

// Integer mills to dollars without floats: 530 -> $0.53.
export function money(mills: number): string {
  const cents = Math.round(mills / 10);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

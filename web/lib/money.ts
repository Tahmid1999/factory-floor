// Integer mills to dollars without floats: 530 -> $0.53, -1700 -> -$1.70.
// The same rounding as the API's dollars().
export function money(mills: number): string {
  const cents = Math.round(mills / 10);
  const c = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

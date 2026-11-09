// The station's copy of the line. The server decides every step and every
// posting; the phone needs the route to know which bundle is next here, and
// the rates to keep the operator's own tally, the way a piece-rate worker
// keeps one in a notebook.

export const ROUTE = ['cut', 'sew_collar', 'sew_sleeve', 'side_seam', 'hem', 'qc_final', 'pack', 'ship'];

export type StationCode = 'S-07' | 'S-08' | 'S-09' | 'S-10' | 'Q-01' | 'Q-02' | 'SUP';

export const STATIONS: Record<StationCode, { op: string; label: string; sewing: boolean }> = {
  'S-07': { op: 'sew_collar', label: 'sew collar', sewing: true },
  'S-08': { op: 'sew_sleeve', label: 'sew sleeve', sewing: true },
  'S-09': { op: 'side_seam', label: 'side seam', sewing: true },
  'S-10': { op: 'hem', label: 'hem', sewing: true },
  'Q-01': { op: 'qc_flag', label: 'inline QC', sewing: false },
  'Q-02': { op: 'qc_final', label: 'QC gate', sewing: false },
  SUP: { op: 'clear_rework', label: 'line supervisor', sewing: false },
};

export const STATION_CODES = Object.keys(STATIONS) as StationCode[];

export const DEFECTS = ['collar', 'sleeve', 'seam', 'hem', 'stain'] as const;
export type Defect = (typeof DEFECTS)[number];

export const PIECES = 20;
const RATE_MILLS: Record<string, number> = { sew_collar: 15, sew_sleeve: 12, side_seam: 11, hem: 8 };
const TRIMS_MILLS: Record<string, number> = { sew_sleeve: 290 };

export function labourMills(op: string): number {
  return (RATE_MILLS[op] ?? 0) * PIECES;
}

// What a step costs if it turns out to be sewn on a bad bundle: the wage and
// the trims it used up. Same sum as the server's waste.
export function stepCostMills(op: string): number {
  return labourMills(op) + (TRIMS_MILLS[op] ?? 0);
}

// Integer mills to dollars without floats: 530 -> $0.53.
export function money(mills: number): string {
  const cents = Math.round(mills / 10);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export const routeIndex = (op: string | null) => (op === null ? -1 : ROUTE.indexOf(op));

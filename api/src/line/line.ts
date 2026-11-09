export type StationCode =
  | 'C-01' | 'S-07' | 'S-08' | 'S-09' | 'S-10'
  | 'Q-01' | 'Q-02' | 'P-01' | 'X-01' | 'SUP';

export const POLO_ROUTE = ['cut', 'sew_collar', 'sew_sleeve', 'side_seam', 'hem', 'qc_final', 'pack', 'ship'];

export const STYLE_CODE = '944';
export const STYLE_NAME = 'polo';
export const PIECES_PER_BUNDLE = 20;

// Gate ops block the bundle until the server answers; the rest queue offline.
// qc_flag, clear_rework and scrap are gate actions that are not route steps.
export const OPERATIONS: { code: string; isGate: boolean; trimsMills: number }[] = [
  { code: 'cut', isGate: true, trimsMills: 0 },
  { code: 'sew_collar', isGate: false, trimsMills: 0 },
  { code: 'sew_sleeve', isGate: false, trimsMills: 290 },
  { code: 'side_seam', isGate: false, trimsMills: 0 },
  { code: 'hem', isGate: false, trimsMills: 0 },
  { code: 'qc_final', isGate: true, trimsMills: 0 },
  { code: 'pack', isGate: false, trimsMills: 0 },
  { code: 'ship', isGate: true, trimsMills: 0 },
  { code: 'qc_flag', isGate: true, trimsMills: 0 },
  { code: 'clear_rework', isGate: true, trimsMills: 0 },
  { code: 'scrap', isGate: true, trimsMills: 0 },
];

// Mills per piece. qc_final and ship are not piece-rate work.
export const RATES_MILLS: Record<string, number> = {
  cut: 10,
  sew_collar: 15,
  sew_sleeve: 12,
  side_seam: 11,
  hem: 8,
  pack: 6,
};

export const RATES_EFFECTIVE_FROM = new Date('2026-01-01T00:00:00Z');

// Visitors act as the ones with simOnly false, on their own bundles only.
export const STATIONS: Record<StationCode, { op: string; gate: boolean; simOnly: boolean }> = {
  'C-01': { op: 'cut', gate: true, simOnly: true },
  'S-07': { op: 'sew_collar', gate: false, simOnly: false },
  'S-08': { op: 'sew_sleeve', gate: false, simOnly: false },
  'S-09': { op: 'side_seam', gate: false, simOnly: false },
  'S-10': { op: 'hem', gate: false, simOnly: false },
  'Q-01': { op: 'qc_flag', gate: true, simOnly: false },
  'Q-02': { op: 'qc_final', gate: true, simOnly: false },
  'P-01': { op: 'pack', gate: false, simOnly: true },
  'X-01': { op: 'ship', gate: true, simOnly: true },
  SUP: { op: 'supervisor', gate: true, simOnly: false },
};

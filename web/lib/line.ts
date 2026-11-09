// The station's copy of the line: the route, to know which bundle is next
// here, and which station does which op. Rates and trims come from /me.

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

export const routeIndex = (op: string | null) => (op === null ? -1 : ROUTE.indexOf(op));

export function stationFor(op: string | null): StationCode | undefined {
  return STATION_CODES.find((s) => STATIONS[s].op === op);
}

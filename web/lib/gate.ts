import { API } from './api';
import { NetworkDown, netFetch } from './net';

const TIMEOUT_MS = 2000;

export const DEFECTS = ['collar', 'sleeve', 'seam', 'hem', 'stain'] as const;

export type GateBody = {
  deviceId: string;
  gateId: string;
  bundleCode: string;
  action: 'qc_flag' | 'qc_pass' | 'qc_fail' | 'clear_rework' | 'scrap';
  defect?: string;
  targetOp?: string;
};

export type GateReply = {
  ok: boolean;
  status: string | null;
  nextOp: string | null;
  round: number;
  message: string;
  ms: number;
  // True when the call never got an answer, as opposed to a refusal.
  down?: boolean;
};

// A gate decides on the spot, so it never queues. No answer within 2 s is the
// same as no network: the operator sees STOP and the bundle stays where it is.
// A retry of the same tap must reuse its gateId, so a call that did land
// before the timeout is answered with its first reply instead of twice.
export async function gateScan(body: GateBody, station: string): Promise<GateReply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const res = await netFetch(
      `${API}/gate/scan`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal },
      station,
    );
    const data = await res.json().catch((e: Error) => {
      if (e.name === 'AbortError') throw e;
      return {};
    });
    if (!res.ok) return { ok: false, status: null, nextOp: null, round: 0, message: data.error ?? `http ${res.status}`, ms: ms() };
    return data as GateReply;
  } catch (e) {
    if (e instanceof NetworkDown || (e as Error).name === 'AbortError') {
      const where = station === 'SUP' ? 'nothing changed' : 'bundle held at QC';
      return { ok: false, status: null, nextOp: null, round: 0, message: `no network · ${where}`, ms: ms(), down: true };
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// crypto.randomUUID needs a secure context, and a phone on the LAN over plain
// http is not one; getRandomValues works everywhere.
export function newGateId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

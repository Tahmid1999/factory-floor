'use client';

import { useCallback, useEffect, useState } from 'react';
import { API, ApiError } from './api';

export const ROLES = ['operator', 'qc', 'storekeeper', 'supervisor', 'accounts', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export type View = 'floor' | 'bundles' | 'held' | 'stations' | 'audit' | 'payroll' | 'pnl' | 'stock';

// A copy of READS in api/src/auth/roles.ts, used only to hide menu items. The
// API is the real guard: a hidden view opened by URL still gets its 403.
export const READS: Record<Role, View[]> = {
  operator: ['floor'],
  qc: ['floor', 'bundles'],
  storekeeper: ['stock'],
  supervisor: ['floor', 'bundles', 'held', 'stations'],
  accounts: ['payroll', 'pnl', 'audit'],
  admin: ['floor', 'bundles', 'held', 'stations', 'audit', 'payroll', 'pnl', 'stock'],
};

export const isRole = (v: string | null): v is Role => v !== null && (ROLES as readonly string[]).includes(v);

export type Floor = {
  ops: { op: string; waiting: number; doneToday: number; rateMills: number; gate: boolean }[];
  simOn: boolean;
  visitors: number;
  tail: string[];
};
export type BundleRow = {
  code: string;
  status: string;
  nextOp: string | null;
  round: number;
  owner: string;
  wastedMills: number;
};
export type TimelineRow = {
  source: 'batch' | 'gate';
  op: string;
  seq: number | null;
  device: string | null;
  deviceKind: 'sim' | 'guest' | null;
  // Set on a visitor's bundle for the sim's rows: "cut by sim-cutter" or "sim-carried".
  label: string | null;
  scannedAt: number | null;
  correctedAt: number;
  receivedAt: number;
  result: string;
  held: boolean;
  released: boolean;
  heldAt: number | null;
  wasted: boolean;
  round: number | null;
  postedMills: number;
};
export type BundleDetail = BundleRow & { events: TimelineRow[] };
export type HeldRow = {
  code: string | null;
  op: string | null;
  device: string | null;
  heldAt: number;
  ageSec: number;
  stuck: boolean;
};
export type StationRow = {
  device: string;
  kind: 'sim' | 'guest';
  guest?: string;
  simName?: string;
  lastSyncAt: number | null;
  lastPending: number;
  clockOffsetMs: number;
  offlineFor: number | null;
};
export type AuditRow = {
  id: string;
  at: number;
  actor: string;
  role: string;
  action: string;
  entity: string;
  before: unknown;
  after: unknown;
};

const POLL_MS = 2500;

// Adds ?as= to a path that may already have a query.
export function withAs(path: string, as: Role | null): string {
  if (!as) return path;
  return `${path}${path.includes('?') ? '&' : '?'}as=${as}`;
}

export async function adminCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `http ${res.status}`, body ?? {});
  return body as T;
}

export type Polled<T> = { data: T | null; error: ApiError | null; offline: boolean };

const BACKOFF_CAP_MS = 30_000;

// Polls every 2.5 s. Only a 403 or 404 is an answer (the role may not read the
// view, or there is no such bundle) and stops the polling until the path
// changes. Anything else, a 502 during a redeploy, a 429, a dropped network,
// keeps the last rows, says so, and retries at 2.5 s doubling to 30 s.
export function usePoll<T>(path: string): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, offline: false });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let wait = POLL_MS;
    setState({ data: null, error: null, offline: false });

    const tick = async () => {
      let delay = POLL_MS;
      try {
        const data = await adminCall<T>(path);
        wait = POLL_MS;
        if (alive) setState({ data, error: null, offline: false });
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          setState({ data: null, error: e, offline: false });
          return;
        }
        setState((s) => ({ ...s, offline: true }));
        delay = wait;
        wait = Math.min(wait * 2, BACKOFF_CAP_MS);
      }
      if (alive) timer = setTimeout(tick, delay);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [path]);

  return state;
}

export type Session = { login: string; role: Role } | null;

// undefined while the first answer is pending, so the header does not flash a
// login link at someone who is already in.
export function useSession(): { session: Session | undefined; reload: () => void } {
  const [session, setSession] = useState<Session | undefined>(undefined);
  const reload = useCallback(() => {
    adminCall<Session>('/admin/session')
      .then((s) => setSession(s ?? null))
      .catch(() => setSession(null));
  }, []);
  useEffect(reload, [reload]);
  return { session, reload };
}

export function hhmmss(ms: number | null, withMs = false): string {
  if (ms === null) return '-';
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return withMs ? `${base}.${p(d.getMilliseconds(), 3)}` : base;
}

// Mills to dollars at the precision rates are set in: 15 -> $0.015.
export function rate(mills: number): string {
  if (mills === 0) return '-';
  return `$${Math.floor(mills / 1000)}.${String(mills % 1000).padStart(3, '0')}`;
}

export type StockRoll = {
  code: string;
  lengthCm: number;
  onHandCm: number;
  costPerMetreMills: number;
  receivedAt: number;
  isSimulated: boolean;
};
export type StockMovement = {
  kind: string;
  deltaCm: number;
  bundleCode: string | null;
  actor: string;
  reason: string | null;
  isSimulated: boolean;
  at: number;
};
export type StressResult = { roll: string; accepted: number; refused: number; onHandCm: number; ms: number };

export type PayrollRow = {
  key: string;
  worker: string;
  kind: 'sim' | 'guest' | 'purged';
  pieces: number;
  paidPieces: number;
  earningsMills: number;
};
export type PayrollScan = { at: string; bundleCode: string; op: string; round: number; pieces: number; mills: number };

export type PeriodRow = { period: string; closed: boolean };
export type PeriodClose = { period: string; closedAt: string; closedBy: string };
export type Pnl = {
  period: string;
  closed: PeriodClose | null;
  revenue: number;
  fabric: number;
  trims: number;
  labour: number;
  adjustment: number;
  late: { from: string; mills: number }[];
  contribution: number;
  writeoff: number;
  wip: { mills: number; asOf: string };
};
export type PostingRow = {
  id: string;
  at: string;
  kind: string;
  amountMills: number;
  period: string;
  adjustsPeriod: string | null;
  bundleCode: string | null;
  op: string | null;
  device: string | null;
  isSimulated: boolean;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// '2026-10' -> 'October'
export const monthName = (period: string): string => MONTHS[Number(period.slice(5, 7)) - 1] ?? period;

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);
export const thisPeriod = (): string => todayUtc().slice(0, 7);

// '2026-11-01T00:05:00.000Z' -> '1 Nov 00:05', in UTC like the periods.
export function utcStamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// HH:MM:SS in UTC, for pages whose days and periods are UTC.
export const utcTime = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

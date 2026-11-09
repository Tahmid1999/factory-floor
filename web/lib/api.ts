import { netFetch } from './net';

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4120';

export type Mode = 'hybrid' | 'async';

export type MeBundle = {
  code: string;
  status: string;
  nextOp: string | null;
  round: number;
  pieces: number;
  wastedMills: number;
  paid: Record<string, number>;
};
// rates are mills per piece and trims mills per bundle, both as the server
// prices them now.
export type Me = {
  guestId: string;
  name: string;
  mode: Mode;
  serverNow: number;
  rates: Record<string, number>;
  trims: Record<string, number>;
  bundles: MeBundle[];
};

export type Verdict = { seq: number; result: 'accepted' | 'duplicate' | 'rejected'; reason?: string };
export type Resync = { bundleCode: string; status: string; nextOp: string | null; round: number };
export type Notice = { id: string; seq: number; bundleCode: string; result: string };
export type BatchReply = { serverNow: number; results: Verdict[]; resync: Resync[]; notices: Notice[] };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const json = { 'content-type': 'application/json' };

async function call<T>(path: string, init: RequestInit, station: string): Promise<T> {
  const res = await netFetch(`${API}${path}`, init, station);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `http ${res.status}`, body);
  return body as T;
}

// The first call has no cookie and makes the guest, so it must run alone: two
// parallel first calls would make two guests. React runs effects twice in dev,
// hence the one shared promise.
let firstMe: Promise<Me> | null = null;

export function getMe(station: string): Promise<Me> {
  if (!firstMe) {
    firstMe = call<Me>('/me', {}, station);
    firstMe.catch(() => (firstMe = null));
    return firstMe;
  }
  return firstMe.then(() => call<Me>('/me', {}, station));
}

export function putMode(mode: Mode, station: string) {
  return call<{ mode: Mode }>('/me/mode', { method: 'PUT', headers: json, body: JSON.stringify({ mode }) }, station);
}

export function refill(station: string) {
  return call<Me>('/me/bundles/refill', { method: 'POST' }, station);
}

export function registerDevice(station: string) {
  return call<{ deviceId: string; registeredAt: string; lastSeq: number }>(
    '/devices',
    { method: 'POST', headers: json, body: JSON.stringify({ station }) },
    station,
  );
}

export function postBatch(body: object, station: string, signal: AbortSignal): Promise<Response> {
  return netFetch(`${API}/scans/batch`, { method: 'POST', headers: json, body: JSON.stringify(body), signal }, station);
}

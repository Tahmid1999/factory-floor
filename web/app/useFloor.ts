'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, Me, MeBundle, Mode, Verdict, getMe, putMode, refill, registerDevice } from '../lib/api';
import { GateBody, GateReply, gateScan, newGateId } from '../lib/gate';
import { STATION_CODES, STATIONS, StationCode, routeIndex, ROUTE } from '../lib/line';
import { offline, onNetChange } from '../lib/net';
import {
  QueuedEvent,
  Unseen,
  WorkRow,
  addUnseen,
  addWork,
  allUnseen,
  drop,
  dropWork,
  enqueue,
  floorSeq,
  getMeta,
  getOffset,
  hasSeq,
  pendingAll,
  setMeta,
  takeUnseen,
  workSince,
} from '../lib/queue';
import { SyncResult, SyncStatus, kick, startSync } from '../lib/sync';

export type Tone = 'idle' | 'wait' | 'ok' | 'stop' | 'resync';
export type FlashState = { tone: Tone; title: string; detail?: string; sub?: string };
export type Settled = { verdict: Verdict; at: number };
export type BatchScan = { deviceId: string; seq: number; greenAt: number; mills: number; settled: Promise<Settled> };
export type ResyncInfo = { station: string; dropped: number; codes: string[]; avoidedMills: number };

const ME_KEY = 'ff-me';
// By guest id, never name: a name is drawn again for a later visitor, who
// would otherwise pick up an expired guest's device and get 403 for it.
const deviceKey = (guestId: string, st: StationCode) => `device:${guestId}:${st}`;
const SEEN_KEY = 'notices-seen';
const SEWING_OPS = new Set(['sew_collar', 'sew_sleeve', 'side_seam', 'hem']);

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Priced from what /me last said, so a rate the admin changes reaches the
// phone with the next refresh. A cached /me from before rates were sent
// prices nothing rather than guess.
function labourOf(me: Me | null, code: string, op: string): number {
  const pieces = me?.bundles.find((b) => b.code === code)?.pieces ?? 0;
  return (me?.rates?.[op] ?? 0) * pieces;
}

function costOf(me: Me | null, code: string, op: string): number {
  return labourOf(me, code, op) + (me?.trims?.[op] ?? 0);
}

// Out of the queue, the tally and the unseen list, device by device.
async function dropEarlierVisit(events: QueuedEvent[]): Promise<void> {
  const byDevice = new Map<string, number[]>();
  for (const e of events) byDevice.set(e.deviceId, [...(byDevice.get(e.deviceId) ?? []), e.seq]);
  for (const [deviceId, seqs] of byDevice) {
    await drop(deviceId, seqs);
    await dropWork(deviceId, seqs);
    await takeUnseen(deviceId);
  }
}

function readCachedMe(): Me | null {
  try {
    const raw = window.localStorage.getItem(ME_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

function cacheMe(me: Me) {
  try {
    window.localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    // Only lets the station open offline; nothing depends on it.
  }
}

// Steps scanned here that the server has not shown as applied yet. Without
// them the next tap would pick the same bundle again until the worker caught up.
type Local = Record<string, string[]>;

function prune(local: Local, me: Me): Local {
  const out: Local = {};
  for (const b of me.bundles) {
    const ops = local[b.code];
    if (!ops || b.status !== 'active' || b.nextOp === null) continue;
    const left = ops.filter((op) => routeIndex(op) >= routeIndex(b.nextOp));
    if (left.length > 0) out[b.code] = left;
  }
  return out;
}

function withLocal(b: MeBundle, local: Local): MeBundle {
  const done = local[b.code];
  if (!done || b.status !== 'active' || b.nextOp === null) return b;
  let i = routeIndex(b.nextOp);
  while (i < ROUTE.length && done.includes(ROUTE[i])) i++;
  return { ...b, nextOp: ROUTE[i] ?? null };
}

export function useFloor() {
  const [me, setMeState] = useState<Me | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [station, setStationState] = useState<StationCode>('S-07');
  const [devices, setDevices] = useState<Partial<Record<StationCode, string>>>({});
  const [syncs, setSyncs] = useState<Record<string, SyncStatus>>({});
  const [flash, setFlash] = useState<FlashState>({ tone: 'idle', title: 'ready' });
  const [local, setLocal] = useState<Local>({});
  const [work, setWork] = useState<WorkRow[]>([]);
  const [gateCheck, setGateCheck] = useState<string | null>(null);
  const [resyncInfo, setResyncInfo] = useState<ResyncInfo | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [unseen, setUnseen] = useState<Record<string, Unseen[]>>({});
  const [trapRunning, setTrapRunning] = useState(false);
  const [, setTick] = useState(0);

  const meRef = useRef<Me | null>(null);
  const stationRef = useRef<StationCode>('S-07');
  const devicesRef = useRef<Partial<Record<StationCode, string>>>({});
  const waiters = useRef(new Map<string, (s: Settled) => void>());
  const seen = useRef(new Set<string>());

  const setMe = useCallback((m: Me) => {
    meRef.current = m;
    setMeState(m);
    setLocal((l) => prune(l, m));
    cacheMe(m);
  }, []);

  const patchBundle = useCallback(
    (code: string, p: { status: string; nextOp: string | null; round: number }) => {
      const m = meRef.current;
      if (!m) return;
      setMe({ ...m, bundles: m.bundles.map((b) => (b.code === code ? { ...b, ...p } : b)) });
      setLocal((l) => {
        const { [code]: _, ...rest } = l;
        return rest;
      });
    },
    [setMe],
  );

  const addLog = useCallback((lines: string[]) => {
    if (lines.length === 0) return;
    const time = new Date().toLocaleTimeString('en-GB');
    setLog((l) => [...lines.map((t) => `${time} ${t}`).reverse(), ...l].slice(0, 6));
  }, []);

  const refreshWork = useCallback(async () => setWork(await workSince(startOfToday())), []);

  const onReply = useCallback(
    async (r: SyncResult) => {
      const codeOf = new Map(r.sent.map((e) => [e.seq, e]));
      const rejected = r.reply.results.filter((v) => v.result === 'rejected');
      for (const v of r.reply.results) {
        waiters.current.get(`${r.deviceId}:${v.seq}`)?.({ verdict: v, at: r.at });
        waiters.current.delete(`${r.deviceId}:${v.seq}`);
      }
      for (const e of r.flushed) {
        waiters.current.get(`${r.deviceId}:${e.seq}`)?.({
          verdict: { seq: e.seq, result: 'rejected', reason: 'resync' },
          at: r.at,
        });
        waiters.current.delete(`${r.deviceId}:${e.seq}`);
      }

      const fresh = r.reply.notices.filter((n) => !seen.current.has(n.id));
      for (const n of fresh) seen.current.add(n.id);
      if (fresh.length > 0) await setMeta(SEEN_KEY, [...seen.current].slice(-200));
      // A late rejection from the worker undoes the tally for that scan.
      const lateRejected = fresh.filter((n) => n.result.startsWith('rejected'));

      await dropWork(r.deviceId, [
        ...rejected.map((v) => v.seq),
        ...r.flushed.map((e) => e.seq),
        ...lateRejected.map((n) => n.seq),
      ]);
      void refreshWork();
      for (const b of r.reply.resync) patchBundle(b.bundleCode, b);

      addLog([
        ...rejected.map(
          (v) => `${r.station} seq ${v.seq} · ${codeOf.get(v.seq)?.bundleCode ?? '?'} · rejected (${v.reason ?? '?'})`,
        ),
        ...r.flushed.map((e) => `${r.station} seq ${e.seq} · ${e.bundleCode} · dropped from queue`),
        ...fresh.map((n) => `${r.station} seq ${n.seq} · ${n.bundleCode} · ${n.result}`),
      ]);

      const bad = [
        ...rejected.map((v) => ({
          seq: v.seq,
          op: codeOf.get(v.seq)?.op ?? '',
          code: codeOf.get(v.seq)?.bundleCode ?? '?',
          reason: v.reason,
        })),
        ...r.flushed.map((e) => ({ seq: e.seq, op: e.op, code: e.bundleCode, reason: 'rework' })),
        ...lateRejected.map((n) => ({ seq: n.seq, op: '', code: n.bundleCode, reason: n.result.slice(9, -1) })),
      ];
      if (bad.length === 0) return;
      // Not looking at that station: keep them until it is opened.
      if (r.station !== stationRef.current) {
        setUnseen(
          await addUnseen(
            r.deviceId,
            bad.map((b) => ({ seq: b.seq, bundleCode: b.code, reason: b.reason ?? '?' })),
          ),
        );
        return;
      }
      const codes = [...new Set(bad.map((b) => b.code))];
      const reasons = new Set(bad.map((b) => b.reason));
      const why = reasons.size === 1 && reasons.has('rework') ? 'went to rework' : [...reasons].join(', ');
      setFlash({
        tone: 'resync',
        title: 'RESYNC',
        detail: `${bad.length} scan${bad.length === 1 ? '' : 's'} rejected`,
        sub: `${codes.join(', ')} ${why}`,
      });
      setResyncInfo({
        station: r.station,
        dropped: bad.length,
        codes,
        avoidedMills: bad
          .filter((b) => b.reason === 'rework')
          .reduce((s, b) => s + costOf(meRef.current, b.code, b.op), 0),
      });
    },
    [addLog, patchBundle, refreshWork],
  );

  const onStatus = useCallback((s: SyncStatus) => setSyncs((all) => ({ ...all, [s.deviceId]: s })), []);
  const handlers = useMemo(() => ({ onReply: (r: SyncResult) => void onReply(r), onStatus }), [onReply, onStatus]);

  const ensureDevice = useCallback(
    async (st: StationCode): Promise<string> => {
      const known = devicesRef.current[st];
      if (known) return known;
      const guestId = meRef.current?.guestId;
      if (!guestId) throw new Error('no guest yet');
      const key = deviceKey(guestId, st);
      let id = await getMeta<string>(key);
      // Registering is idempotent and answers with the last seq the server
      // holds, so a counter lost with the browser's storage starts above it.
      if (!id || !(await hasSeq(id))) {
        const reg = await registerDevice(st);
        id = reg.deviceId;
        await floorSeq(id, reg.lastSeq);
        await setMeta(key, id);
      }
      devicesRef.current = { ...devicesRef.current, [st]: id };
      setDevices(devicesRef.current);
      startSync(id, st, handlers);
      return id;
    },
    [handlers],
  );

  const refreshMe = useCallback(async (): Promise<Me | null> => {
    try {
      const m = await getMe(stationRef.current);
      setMe(m);
      return m;
    } catch {
      return null;
    }
  }, [setMe]);

  // Boot: the guest first, alone, then a sync loop for every device this guest
  // has used here, so a queue left by a closed tab drains on load.
  useEffect(() => {
    void (async () => {
      let m: Me | null = null;
      try {
        m = await getMe('S-07');
      } catch {
        m = readCachedMe();
      }
      if (!m) {
        setBootError('no network · open this page online once');
        return;
      }
      setMe(m);
      seen.current = new Set((await getMeta<string[]>(SEEN_KEY)) ?? []);
      const mine = new Set<string>();
      // A /me cached before guest ids were sent cannot say whose a device is,
      // so nothing is judged an earlier visit's on it.
      for (const st of m.guestId ? STATION_CODES : []) {
        const id = await getMeta<string>(deviceKey(m.guestId, st));
        if (!id) continue;
        mine.add(id);
        // The queue drains either way; scanning waits for a known seq.
        startSync(id, st, handlers);
        if (await hasSeq(id)) devicesRef.current = { ...devicesRef.current, [st]: id };
      }
      setDevices(devicesRef.current);
      const queued = await pendingAll();
      const fromQueue: Local = {};
      for (const e of queued) {
        if (mine.has(e.deviceId) && SEWING_OPS.has(e.op)) (fromQueue[e.bundleCode] ??= []).push(e.op);
      }
      setLocal(fromQueue);
      // Scans a visit queued and never sent, from a guest the server has
      // since purged: their device is no longer this guest's and would get 403
      // for good. The visitor is told once, then they go.
      const earlier = m.guestId ? queued.filter((e) => !mine.has(e.deviceId)) : [];
      if (earlier.length > 0) {
        await dropEarlierVisit(earlier);
        const text = `${earlier.length} scan${earlier.length === 1 ? '' : 's'} from an earlier visit could not be sent · that visit expired`;
        setFlash({ tone: 'resync', title: 'RESYNC', detail: text });
        addLog([text]);
      }
      setUnseen(await allUnseen());
      await refreshWork();
      await ensureDevice(stationRef.current)
        .then(() => openUnseen(stationRef.current))
        .catch(() => undefined);
    })();
    // Boot runs once; the handlers it hands out are stable.
  }, []);

  // Countdowns on screen (next retry, the scenario drop) need a clock.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    const off = onNetChange(() => setTick((n) => n + 1));
    return () => {
      clearInterval(t);
      off();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => void refreshMe(), 5000);
    return () => clearInterval(t);
  }, [refreshMe]);

  // Opening a station is where its operator sees what was rejected meanwhile.
  const openUnseen = useCallback(async (st: StationCode) => {
    const id = devicesRef.current[st];
    if (!id) return;
    const { taken, all } = await takeUnseen(id);
    setUnseen(all);
    if (taken.length === 0 || stationRef.current !== st) return;
    const reasons = [...new Set(taken.map((u) => u.reason))].join(', ');
    setFlash({
      tone: 'resync',
      title: 'RESYNC',
      detail: `${taken.length} scan${taken.length === 1 ? '' : 's'} rejected while you were away`,
      sub: `${[...new Set(taken.map((u) => u.bundleCode))].join(', ')} · ${reasons}`,
    });
  }, []);

  const setStation = useCallback(
    (st: StationCode) => {
      stationRef.current = st;
      setStationState(st);
      setFlash({ tone: 'idle', title: 'ready' });
      setGateCheck(null);
      setResyncInfo(null);
      void ensureDevice(st)
        .then(() => openUnseen(st))
        .catch(() => undefined);
    },
    [ensureDevice, openUnseen],
  );

  // A sewing scan is green the moment it is in IndexedDB. The network is the
  // sync loop's problem, never the operator's.
  const batchScan = useCallback(
    async (st: StationCode, code: string, op: string): Promise<BatchScan> => {
      const t0 = performance.now();
      const deviceId = await ensureDevice(st);
      const round = meRef.current?.bundles.find((b) => b.code === code)?.round ?? 0;
      const seq = await enqueue(deviceId, {
        bundleCode: code,
        op,
        scannedAt: Date.now(),
        offsetMs: await getOffset(),
        round,
      });
      const greenAt = Date.now();
      const ms = Math.round(performance.now() - t0);
      setFlash({
        tone: 'ok',
        title: 'OK',
        detail: offline(st) ? `${code} · queued locally` : `${code} · ${op} · ${ms} ms`,
      });
      setResyncInfo(null);
      if (SEWING_OPS.has(op)) setLocal((l) => ({ ...l, [code]: [...(l[code] ?? []), op] }));
      const settled = new Promise<Settled>((res) => waiters.current.set(`${deviceId}:${seq}`, res));
      kick(deviceId);
      let mills = 0;
      if (SEWING_OPS.has(op)) {
        mills = await addWork(
          {
            deviceId,
            seq,
            bundleCode: code,
            op,
            station: st,
            pieces: meRef.current?.bundles.find((b) => b.code === code)?.pieces ?? 0,
            at: greenAt,
          },
          labourOf(meRef.current, code, op),
        );
        void refreshWork();
      }
      return { deviceId, seq, greenAt, mills, settled };
    },
    [ensureDevice, refreshWork],
  );

  // A gate waits for the server: the flash stays grey until it answers.
  const gate = useCallback(
    async (
      st: StationCode,
      action: GateBody['action'],
      code: string,
      extra: { defect?: string; targetOp?: string; gateId?: string } = {},
    ): Promise<GateReply> => {
      setFlash({ tone: 'wait', title: 'checking', detail: `${code} · ${action}` });
      setResyncInfo(null);
      let r: GateReply;
      try {
        const deviceId = await ensureDevice(st);
        r = await gateScan(
          { deviceId, gateId: extra.gateId ?? newGateId(), bundleCode: code, action, defect: extra.defect, targetOp: extra.targetOp },
          st,
        );
      } catch (e) {
        const message = e instanceof ApiError ? e.message : 'no network · bundle held at QC';
        r = { ok: false, status: null, nextOp: null, round: 0, message, ms: 0, down: !(e instanceof ApiError) };
      }
      const stop = !r.ok || action === 'qc_flag' || action === 'qc_fail' || action === 'scrap';
      setFlash({ tone: stop ? 'stop' : 'ok', title: stop ? 'STOP' : 'OK', detail: r.message });
      setGateCheck(r.down ? 'no network' : `live · ${r.ms} ms`);
      if (r.status) patchBundle(code, { status: r.status, nextOp: r.nextOp, round: r.round });
      addLog([`${st} ${code} ${action} · ${r.message}`]);
      return r;
    },
    [addLog, ensureDevice, patchBundle],
  );

  const setMode = useCallback(
    async (mode: Mode) => {
      await putMode(mode, stationRef.current);
      if (meRef.current) setMe({ ...meRef.current, mode });
    },
    [setMe],
  );

  const refillBundles = useCallback(async () => {
    const m = await refill(stationRef.current);
    setMe(m);
    return m;
  }, [setMe]);

  const bundles = useMemo(() => (me ? me.bundles.map((b) => withLocal(b, local)) : []), [me, local]);

  // The bundle "Scan next bundle" would take at this station, if any.
  const nextHere = useCallback(
    (st: StationCode): MeBundle | undefined => {
      const active = bundles.filter((b) => b.status === 'active');
      if (STATIONS[st].sewing) return active.find((b) => b.nextOp === STATIONS[st].op);
      if (st === 'Q-01') {
        return active.find(
          (b) => routeIndex(b.nextOp) > routeIndex('sew_collar') && routeIndex(b.nextOp) <= routeIndex('qc_final'),
        );
      }
      if (st === 'Q-02') return active.find((b) => b.nextOp === 'qc_final');
      return bundles.find((b) => b.status === 'rework');
    },
    [bundles],
  );

  // Rejections waiting at stations other than this one, by station.
  const unseenAt = useMemo(() => {
    const out: Partial<Record<StationCode, number>> = {};
    for (const st of STATION_CODES) {
      const id = devices[st];
      if (id && st !== station && (unseen[id]?.length ?? 0) > 0) out[st] = unseen[id].length;
    }
    return out;
  }, [devices, unseen, station]);

  return {
    me,
    unseenAt,
    trapRunning,
    setTrapRunning,
    bootError,
    bundles,
    station,
    devices,
    syncs,
    flash,
    work,
    gateCheck,
    resyncInfo,
    log,
    setFlash,
    setStation,
    ensureDevice,
    refreshMe,
    batchScan,
    gate,
    setMode,
    refillBundles,
    nextHere,
  };
}

export type Floor = ReturnType<typeof useFloor>;

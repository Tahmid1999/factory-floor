'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, Me, MeBundle, Mode } from '../lib/api';
import { newGateId } from '../lib/gate';
import { StationCode, routeIndex, stationFor } from '../lib/line';
import { money } from '../lib/money';
import { dropFor, dropLeft, offline, onNetChange } from '../lib/net';
import { Floor } from './useFloor';

const DROP_MS = Number(process.env.NEXT_PUBLIC_TRAP_DROP_MS ?? 20000);
// A client courtesy only; the server's batch and gate limits are the guard.
const COOLDOWN_MS = 15_000;
const TRAP_STATIONS: StationCode[] = ['S-07', 'Q-01', 'S-08', 'SUP'];

// 0 not running, 1 the QC tap, 2 the S-08 scan, 3 waiting for the result,
// 4 the supervisor's clear, 5 the redo at S-07, 6 finished.
type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each check is a /me read, and the server allows an address 120 a minute;
// once a second leaves room for the station's own refresh and a second tab.
async function until<T>(check: () => Promise<T | undefined>, ms: number, every = 1000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v !== undefined) return v;
    await sleep(every);
  }
  return undefined;
}

// A fresh bundle is round 0 and active. One whose collar is already sewn goes
// first, since that is the one the visitor just scanned; otherwise the trap
// sews the collar itself, because QC can only flag after the collar.
function pick(bundles: MeBundle[]): MeBundle | undefined {
  const fresh = bundles.filter((b) => b.status === 'active' && b.round === 0);
  return fresh.find((b) => b.nextOp === 'sew_sleeve') ?? fresh.find((b) => b.nextOp === 'sew_collar');
}

export function TrapCard({ floor }: { floor: Floor }) {
  const mode: Mode = floor.me?.mode ?? 'hybrid';
  const [step, setStep] = useState<Step>(0);
  const [code, setCode] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Partial<Record<Step, string>>>({});
  const [note, setNote] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const runMode = useRef<Mode>(mode);
  const gateId = useRef<string | null>(null);
  const flagging = useRef(false);
  // Where the clear sent the bundle, and what that op had been paid before
  // the redo, both as the server said.
  const redo = useRef<{ op: string; round: number; paidBefore: number | undefined } | null>(null);

  const line = (s: Step, text: string) => setLines((l) => ({ ...l, [s]: text }));
  const running = step > 0 && step < 6;
  const cooldown = Math.max(0, startedAt + COOLDOWN_MS - Date.now());
  const { setTrapRunning } = floor;

  useEffect(() => setTrapRunning(running), [running, setTrapRunning]);

  // The bundle as /me reports it, once /me answers with it; undefined if it
  // never does, so the card says "unknown" instead of printing a zero.
  async function serverBundle(code: string, ready: (b: MeBundle) => boolean = () => true, ms = 10_000) {
    return until(async () => {
      const b = (await floor.refreshMe())?.bundles.find((x) => x.code === code);
      return b && ready(b) ? b : undefined;
    }, ms);
  }

  async function start() {
    setNote(null);
    setLines({});
    setHeld(false);
    setBusy(true);
    try {
      const m: Me | null = (await floor.refreshMe()) ?? floor.me;
      let b = pick(m?.bundles ?? []);
      if (!b) {
        try {
          b = pick((await floor.refillBundles()).bundles);
        } catch (e) {
          const blocking = e instanceof ApiError ? e.body.bundle : undefined;
          setNote(
            typeof blocking === 'string'
              ? `no fresh bundle left · sew the collar on ${blocking} at S-07 to get more`
              : (e as Error).message,
          );
          return;
        }
      }
      if (!b) return setNote('no fresh bundle to use');
      const bundle = b.code;
      setCode(bundle);
      runMode.current = mode;
      setStartedAt(Date.now());
      try {
        await Promise.all(TRAP_STATIONS.map((s) => floor.ensureDevice(s)));
      } catch {
        return setNote('no network · try again online');
      }

      if (b.nextOp === 'sew_collar') {
        line(0, `S-07 · sewing the collar on ${bundle}`);
        floor.setStation('S-07');
        const s = await floor.batchScan('S-07', bundle, 'sew_collar');
        const { verdict } = await s.settled;
        if (verdict.result === 'rejected') return setNote(`collar scan rejected (${verdict.reason})`);
        const applied = await until(async () => {
          const now = await floor.refreshMe();
          const nb = now?.bundles.find((x) => x.code === bundle);
          return nb && nb.nextOp !== 'sew_collar' ? nb : undefined;
        }, 10_000);
        if (!applied) return setNote('the collar has not reached the server yet, try again');
      }
      line(0, `collar on ${bundle} done at S-07`);
      floor.setStation('Q-01');
      setStep(1);
    } finally {
      setBusy(false);
    }
  }

  // Hybrid: the flag is a live gate call, so with QC's Wi-Fi down it fails and
  // the bundle may not leave QC. The same gateId is reused on every retry.
  async function flagLive() {
    if (!code || flagging.current) return;
    flagging.current = true;
    try {
      const r = await floor.gate('Q-01', 'qc_flag', code, { defect: 'collar', gateId: gateId.current! });
      line(1, r.message);
      setHeld(!r.ok);
      if (r.ok) setStep(2);
    } finally {
      flagging.current = false;
    }
  }

  async function qcTap() {
    if (!code) return;
    setBusy(true);
    try {
      dropFor('Q-01', DROP_MS);
      if (runMode.current === 'async') {
        await floor.batchScan('Q-01', code, 'qc_flag');
        line(1, `flag queued on Q-01 · ${code} · defect: collar`);
        setStep(2);
      } else {
        gateId.current = newGateId();
        await flagLive();
      }
    } finally {
      setBusy(false);
    }
  }

  // When QC's Wi-Fi comes back the held flag goes through by itself.
  useEffect(() => {
    if (step !== 1 || !held) return;
    return onNetChange(() => {
      if (!offline('Q-01')) void flagLive();
    });
    // flagLive reads refs and the current code only.
  }, [step, held, code]);

  async function sleeveTap() {
    if (!code) return;
    setBusy(true);
    try {
      floor.setStation('S-08');
      const s = await floor.batchScan('S-08', code, 'sew_sleeve');
      setStep(3);
      const { verdict, at } = await s.settled;
      if (verdict.result === 'rejected') {
        const b = await serverBundle(code);
        const waste = b ? `${money(b.wastedMills)} wasted` : 'waste unknown';
        // Stopped means stopped by the rework; any other rejection is its own story.
        const stopped = verdict.reason === 'rework' || verdict.reason === 'resync';
        const secs = ((at - s.greenAt) / 1000).toFixed(1);
        line(3, stopped ? `stopped at S-08 in ${secs} s · ${waste}` : `S-08 scan rejected (${verdict.reason}) · ${waste}`);
        setStep(stopped ? 4 : 6);
        return;
      }
      line(3, 'sleeve sewn · the flag is still in Q-01’s queue');
      const landed = await serverBundle(code, (b) => b.status !== 'active', DROP_MS + 45_000);
      if (!landed) {
        line(3, 'the flag has not landed yet · waste unknown');
        return;
      }
      line(3, `sleeve sewn on a rework bundle · ${money(landed.wastedMills)} wasted`);
      setStep(4);
    } finally {
      setBusy(false);
    }
  }

  async function clearTap() {
    if (!code) return;
    setBusy(true);
    try {
      floor.setStation('SUP');
      const r = await floor.gate('SUP', 'clear_rework', code, { targetOp: 'sew_collar' });
      if (!r.ok || !r.nextOp) return setNote(r.message);
      const at = stationFor(r.nextOp);
      const before = await serverBundle(code, (b) => b.round === r.round);
      redo.current = { op: r.nextOp, round: r.round, paidBefore: before?.paid[r.nextOp] };
      if (at) floor.setStation(at);
      line(4, `${code} back at ${at ?? r.nextOp} · round ${r.round}`);
      setStep(5);
    } finally {
      setBusy(false);
    }
  }

  async function redoTap() {
    if (!code) return;
    setBusy(true);
    try {
      const r = redo.current;
      const at = r && stationFor(r.op);
      if (!r || !at) return setNote('nothing to redo');
      const s = await floor.batchScan(at, code, r.op);
      const { verdict } = await s.settled;
      if (verdict.result !== 'accepted') {
        line(5, `redo ${verdict.result}${verdict.reason ? ` (${verdict.reason})` : ''}`);
        return setStep(6);
      }
      // What the server posted for the redo: the op's labour now, less what it
      // had been paid before, read once the redo has been applied.
      const after = await serverBundle(code, (b) => b.round === r.round && routeIndex(b.nextOp) > routeIndex(r.op));
      if (!after || r.paidBefore === undefined) line(5, 'redo accepted · pay unknown');
      else {
        const paid = (after.paid[r.op] ?? 0) - r.paidBefore;
        line(5, paid === 0 ? `${money(0)} · rework, not paid again` : `${r.op} redone · ${money(paid)}`);
      }
      setStep(6);
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(m: Mode) {
    try {
      await floor.setMode(m);
    } catch {
      setNote('no network · mode not changed');
    }
  }

  const qcLeft = Math.ceil(dropLeft('Q-01') / 1000);
  const dropSecs = Math.round(DROP_MS / 1000);
  const c = code ?? 'the bundle';

  return (
    <section className="trap" aria-label="qc trap">
      <div className="modes" role="group" aria-label="mode">
        <button className={mode === 'hybrid' ? 'on' : undefined} disabled={running} onClick={() => void changeMode('hybrid')}>
          hybrid (gates live)
        </button>
        <button className={mode === 'async' ? 'on' : undefined} disabled={running} onClick={() => void changeMode('async')}>
          all async
        </button>
      </div>

      <div className="card">
        <div className="card-head">
          <b>QC trap</b>
          <span className="mono">{running ? `${c} · ${runMode.current}` : mode}</span>
        </div>
        {lines[0] && <p className="step-line mono">{lines[0]}</p>}
        <ol>
          <li className={step === 1 ? 'now' : undefined}>
            <span>Q-01 loses wifi for {dropSecs} s. I flag the collar.</span>
            <button disabled={step !== 1 || busy || held} onClick={() => void qcTap()}>
              defect: collar
            </button>
            {step === 1 && held && (
              <button disabled={flagging.current} onClick={() => void flagLive()}>
                retry
              </button>
            )}
            {lines[1] && <span className="step-line mono">{lines[1]}</span>}
            {qcLeft > 0 && <span className="step-line mono">Q-01 wifi back in {qcLeft} s</span>}
          </li>
          <li className={step === 2 ? 'now' : undefined}>
            <span>S-08 is online and sews the sleeve.</span>
            <button disabled={step !== 2 || busy} onClick={() => void sleeveTap()}>
              scan {c} at S-08
            </button>
          </li>
          <li className={step === 3 ? 'now' : undefined}>
            <span>Result</span>
            <span className="step-line mono" data-testid="trap-result">
              {lines[3] ?? '-'}
            </span>
          </li>
          <li className={step === 4 || step === 5 ? 'now' : undefined}>
            <span>The supervisor clears it and S-07 redoes the collar.</span>
            <button disabled={step !== 4 || busy} onClick={() => void clearTap()}>
              clear rework → sew_collar
            </button>
            {lines[4] && <span className="step-line mono">{lines[4]}</span>}
            <button disabled={step !== 5 || busy} onClick={() => void redoTap()}>
              {redo.current ? `redo ${redo.current.op} at ${stationFor(redo.current.op)}` : 'redo the sent-back step'}
            </button>
            {lines[5] && (
              <span className="step-line mono" data-testid="trap-redo">
                {lines[5]}
              </span>
            )}
          </li>
        </ol>
        {note && <p className="note-line">{note}</p>}
        <button className="btn" disabled={running || busy || cooldown > 0} onClick={() => void start()}>
          {cooldown > 0 && !running ? `run again in ${Math.ceil(cooldown / 1000)} s` : 'Run the QC trap'}
        </button>
      </div>
    </section>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { Me, MeBundle, Mode } from '../lib/api';
import { newGateId } from '../lib/gate';
import { StationCode, money } from '../lib/line';
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

async function until<T>(check: () => Promise<T | undefined>, ms: number, every = 500): Promise<T | undefined> {
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

  const line = (s: Step, text: string) => setLines((l) => ({ ...l, [s]: text }));
  const running = step > 0 && step < 6;
  const cooldown = Math.max(0, startedAt + COOLDOWN_MS - Date.now());

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
          setNote((e as Error).message);
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
        const m = await floor.refreshMe();
        const wasted = m?.bundles.find((b) => b.code === code)?.wastedMills ?? 0;
        const secs = ((at - s.greenAt) / 1000).toFixed(1);
        line(3, `stopped at S-08 in ${secs} s · ${money(wasted)} wasted`);
        setStep(4);
        return;
      }
      line(3, 'sleeve sewn · the flag is still in Q-01’s queue');
      const landed = await until(async () => {
        const m = await floor.refreshMe();
        const b = m?.bundles.find((x) => x.code === code);
        return b && b.status !== 'active' ? b : undefined;
      }, DROP_MS + 45_000, 1000);
      if (!landed) {
        line(3, 'the flag has not landed yet');
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
      if (!r.ok) return setNote(r.message);
      floor.setStation('S-07');
      line(4, `${code} back at S-07 · round ${r.round}`);
      setStep(5);
    } finally {
      setBusy(false);
    }
  }

  async function redoTap() {
    if (!code) return;
    setBusy(true);
    try {
      const s = await floor.batchScan('S-07', code, 'sew_collar');
      line(5, s.mills === 0 ? `${money(0)} · rework, not paid again` : `collar redone · ${money(s.mills)}`);
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
              redo collar at S-07
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

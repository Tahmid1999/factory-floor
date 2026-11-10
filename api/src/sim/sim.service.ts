import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock } from '../clock';
import { DEFECTS, Defect } from '../gate/gate.service';
import { hit } from '../limits';
import { POLO_ROUTE } from '../line/line';
import { HttpReply, Resync, Send, SimDevice } from './sim-device';

export const SIM_CONFIG = Symbol('SIM_CONFIG');

export type SimConfig = {
  baseUrl: string;
  key: string;
  tickMs: number;
  random: () => number;
  // Per batch device per tick.
  offlineChance: number;
  offlineMs: [number, number];
  flagChance: number;
  failChance: number;
  clearAfterMs: number;
  // C-01 cuts while fewer than this many wait at the collar.
  collarTarget: number;
};

export function simConfigFromEnv(env: NodeJS.ProcessEnv): SimConfig {
  return {
    baseUrl: env.API_INTERNAL_URL ?? `http://127.0.0.1:${env.PORT ?? 4120}`,
    key: env.SIM_KEY ?? '',
    tickMs: Number(env.SIM_TICK_MS) || 3000,
    random: Math.random,
    offlineChance: 0.02,
    offlineMs: [20_000, 60_000],
    flagChance: 0.03,
    failChance: 0.03,
    clearAfterMs: 60_000,
    collarTarget: 6,
  };
}

// The sim is a client of the public api. It is given a base url and the key,
// and nothing else, so what it produces is what the api produces for a phone.
function httpTo(baseUrl: string, key: string) {
  const headers = { 'content-type': 'application/json', 'x-sim-key': key };
  const reply = async (r: Response): Promise<HttpReply> => ({ status: r.status, body: await r.json().catch(() => null) });
  const send: Send = async (path, body) =>
    reply(await fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }));
  const get = async (path: string) => reply(await fetch(baseUrl + path, { headers, signal: AbortSignal.timeout(5000) }));
  return { send, get };
}

// Operators first (sim-op-01..08, one per station), then the two helpers.
const BATCH_STATIONS = ['S-07', 'S-08', 'S-09', 'S-10', 'P-01'];
const OPERATORS: { station: string; simName: string }[] = [
  { station: 'S-07', simName: 'sim-op-01' },
  { station: 'S-08', simName: 'sim-op-02' },
  { station: 'S-09', simName: 'sim-op-03' },
  { station: 'S-10', simName: 'sim-op-04' },
  { station: 'Q-01', simName: 'sim-op-05' },
  { station: 'Q-02', simName: 'sim-op-06' },
  { station: 'P-01', simName: 'sim-op-07' },
  { station: 'X-01', simName: 'sim-op-08' },
  { station: 'C-01', simName: 'sim-cutter' },
  { station: 'SUP', simName: 'sim-sup' },
];

// sim-store is not a station and registers no device: receiving fabric is not
// a scan. Its move costs one read, and a write only when stock is low.
const ROUND_ROBIN = ['C-01', 'S-07', 'S-08', 'S-09', 'S-10', 'Q-01', 'Q-02', 'P-01', 'X-01', 'SUP', 'sim-store'];
const OP_AT: Record<string, string> = { 'S-07': 'sew_collar', 'S-08': 'sew_sleeve', 'S-09': 'side_seam', 'S-10': 'hem', 'P-01': 'pack' };

// The storekeeper orders a lot of 6 once fewer than 3 rolls can cut a bundle,
// at a price drawn from 3200 to 3600 a metre in steps of 50.
const LOW_ROLLS = 3;
const LOT_ROLLS = 6;
const LOT_PRICES = Array.from({ length: 9 }, (_, i) => 3200 + 50 * i);

// The op a defect sends a bundle back to: the station that made it.
const DEFECT_OP: Record<Defect, string> = {
  collar: 'sew_collar',
  sleeve: 'sew_sleeve',
  seam: 'side_seam',
  hem: 'hem',
  stain: 'sew_collar',
};

// The sim runs for months, so what it remembers is capped; the oldest go first
// (a Set and a Map iterate in insertion order). Anything forgotten early is at
// worst scanned again and answered as a duplicate.
const MEMORY = 5000;
function remember<K>(m: Set<K> | Map<K, unknown>, key: K, value?: unknown): void {
  if (m instanceof Set) m.add(key);
  else m.set(key, value);
  if (m.size > MEMORY) m.delete(m.keys().next().value as K);
}

type Waiting = { code: string; nextOp: string | null; flaggedAt?: number };

export type SimStats = { cuts: number; flags: number; fails: number; clears: number; offlineSpells: number };

@Injectable()
export class SimService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SimService.name);
  readonly stats: SimStats = { cuts: 0, flags: 0, fails: 0, clears: 0, offlineSpells: 0 };
  readonly batch = new Map<string, SimDevice>();

  private readonly http: ReturnType<typeof httpTo>;
  private readonly gateIds = new Map<string, string>();
  private readonly offlineUntil = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private cursor: number | null = null;

  // Memory the sim keeps because a real operator would: what it already
  // scanned, which bundle it looked at, and why it flagged one.
  private readonly scanned = new Set<string>();
  private readonly inspected = new Set<string>();
  // Kept apart from inline QC's: inline QC also looks at bundles waiting for
  // final QC, and with one set that look stood in for the final check.
  private readonly finalChecked = new Set<string>();
  private readonly defects = new Map<string, Defect>();
  // Where a bundle goes next after a scan that is still waiting to be sent.
  private readonly onward = new Map<string, string>();

  constructor(
    @Inject(SIM_CONFIG) private readonly cfg: SimConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.http = httpTo(cfg.baseUrl, cfg.key);
  }

  onModuleInit() {
    if (process.env.SIM_ENABLED === '0') return;
    this.timer = setInterval(() => void this.tick(), this.cfg.tickMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // One move on the line. Ticks never overlap: a slow api makes the sim slow,
  // not a pile of concurrent scans.
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.register())) return;
      await this.flipOnline();
      const n = ROUND_ROBIN.length;
      const start = this.cursor ?? Math.floor(this.cfg.random() * n);
      for (let i = 0; i < n; i++) {
        const at = (start + i) % n;
        if (await this.act(ROUND_ROBIN[at])) {
          this.cursor = (at + 1) % n;
          return;
        }
      }
      this.cursor = (start + 1) % n;
    } catch (err) {
      this.log.warn(`tick failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // Idempotent on the api side, so a restart gets the same devices back. A
  // failure (api not up yet) is simply tried again on the next tick.
  private async register(): Promise<boolean> {
    for (const o of OPERATORS) {
      if (this.gateIds.has(o.station) || this.batch.has(o.station)) continue;
      let r: HttpReply;
      try {
        r = await this.http.send('/devices', { station: o.station, simName: o.simName });
      } catch (err) {
        this.warnOnce('register', `${o.station}: ${(err as Error).message}`);
        return false;
      }
      if (r.status !== 201) {
        this.warnOnce('register', `${o.station}: http ${r.status}`);
        return false;
      }
      if (BATCH_STATIONS.includes(o.station)) {
        this.batch.set(
          o.station,
          new SimDevice({
            deviceId: r.body.deviceId,
            station: o.station,
            send: this.http.send,
            clock: this.clock,
            onResync: (x) => this.onResync(x),
          }),
        );
      } else {
        this.gateIds.set(o.station, r.body.deviceId);
      }
    }
    return true;
  }

  private async flipOnline(): Promise<void> {
    const now = this.clock.now().getTime();
    const [lo, hi] = this.cfg.offlineMs;
    for (const [station, dev] of this.batch) {
      if (dev.online) {
        if (this.cfg.random() < this.cfg.offlineChance) {
          dev.online = false;
          this.offlineUntil.set(station, now + lo + this.cfg.random() * (hi - lo));
          this.stats.offlineSpells++;
        }
      } else if (now >= (this.offlineUntil.get(station) ?? 0)) {
        await dev.setOnline(true);
      }
    }
  }

  private async act(station: string): Promise<boolean> {
    switch (station) {
      case 'C-01':
        return this.cut();
      case 'Q-01':
        return this.inspectInline();
      case 'Q-02':
        return this.finalCheck();
      case 'X-01':
        return this.ship();
      case 'SUP':
        return this.supervise();
      case 'sim-store':
        return this.store();
      default:
        return this.sew(station);
    }
  }

  private async work(station: string): Promise<{ bundles: Waiting[]; waitingAtCollar?: number } | null> {
    try {
      const r = await this.http.get(`/sim/work?station=${station}`);
      if (r.status === 200) return r.body;
      this.warnOnce('work', `${station}: http ${r.status}`);
      return null;
    } catch (err) {
      this.warnOnce('work', `${station}: ${(err as Error).message}`);
      return null;
    }
  }

  // A sim that cannot reach the api (wrong key, api down, a 404 from the
  // sim-caller check) otherwise stands still without a word. One line a
  // minute per kind says why without filling the log every tick.
  private warnOnce(what: 'register' | 'work' | 'stock', why: string): void {
    if (!hit(`sim-warn:${what}`, 1, 60, this.clock.now().getTime())) return;
    this.log.warn(`sim ${what} failed, ${why}`);
  }

  private async store(): Promise<boolean> {
    try {
      const r = await this.http.get('/sim/stock');
      if (r.status !== 200) {
        this.warnOnce('stock', `http ${r.status}`);
        return false;
      }
      if (r.body.cuttableRolls >= LOW_ROLLS) return false;
      const costPerMetreMills = LOT_PRICES[Math.floor(this.cfg.random() * LOT_PRICES.length)];
      const got = await this.http.send('/stock/receive', { count: LOT_ROLLS, costPerMetreMills });
      if (got.status !== 201) this.warnOnce('stock', `receive http ${got.status}`);
      return got.status === 201;
    } catch (err) {
      this.warnOnce('stock', (err as Error).message);
      return false;
    }
  }

  private async cut(): Promise<boolean> {
    const w = await this.work('C-01');
    if (!w || (w.waitingAtCollar ?? this.cfg.collarTarget) >= this.cfg.collarTarget) return false;
    const r = await this.gate('C-01', { action: 'cut' });
    if (r?.ok) this.stats.cuts++;
    return r !== null;
  }

  // A batch station scans like a phone: the scan goes in the queue and out to
  // the api, and whether it applied is learned later from a resync or notice.
  private async sew(station: string): Promise<boolean> {
    const dev = this.batch.get(station)!;
    const op = OP_AT[station];
    const w = await this.work(station);
    // A bundle whose earlier scan is still waiting on an offline phone has
    // already walked on to this table, so the scan is made here regardless.
    // The api holds it until the earlier one lands.
    const ahead = [...this.onward]
      .filter(([code, next]) => next === op && [...this.batch.values()].some((d) => d !== dev && d.isQueued(code)))
      .map(([code]) => code);
    const codes = [...ahead, ...(w?.bundles.map((b) => b.code) ?? [])];
    const code = codes.find((c) => !this.scanned.has(`${c}:${op}`));
    if (!code) return false;
    remember(this.scanned, `${code}:${op}`);
    const next = POLO_ROUTE[POLO_ROUTE.indexOf(op) + 1];
    remember(this.onward, code, next);
    await dev.scan(code, op);
    return true;
  }

  private async inspectInline(): Promise<boolean> {
    const w = await this.work('Q-01');
    const b = w?.bundles.find((x) => !this.inspected.has(`${x.code}:${x.nextOp}`));
    if (!b) return false;
    remember(this.inspected, `${b.code}:${b.nextOp}`);
    // Only a step already sewn can be the defect.
    const seen = POLO_ROUTE.indexOf(b.nextOp!);
    const possible = DEFECTS.filter((d) => POLO_ROUTE.indexOf(DEFECT_OP[d]) < seen);
    if (this.cfg.random() < this.cfg.flagChance && possible.length > 0) {
      const defect = possible[Math.floor(this.cfg.random() * possible.length)];
      const r = await this.gate('Q-01', { action: 'qc_flag', bundleCode: b.code, defect });
      if (r?.ok) {
        this.defects.set(b.code, defect);
        this.stats.flags++;
      }
    }
    return true;
  }

  private async finalCheck(): Promise<boolean> {
    const w = await this.work('Q-02');
    const b = w?.bundles.find((x) => !this.finalChecked.has(`${x.code}:${x.nextOp}`));
    if (!b) return false;
    remember(this.finalChecked, `${b.code}:${b.nextOp}`);
    if (this.cfg.random() < this.cfg.failChance) {
      const defect = DEFECTS[Math.floor(this.cfg.random() * DEFECTS.length)];
      const r = await this.gate('Q-02', { action: 'qc_fail', bundleCode: b.code, defect });
      if (r?.ok) {
        this.defects.set(b.code, defect);
        this.stats.fails++;
      }
    } else {
      await this.gate('Q-02', { action: 'qc_pass', bundleCode: b.code });
    }
    return true;
  }

  private async ship(): Promise<boolean> {
    const w = await this.work('X-01');
    const b = w?.bundles[0];
    if (!b) return false;
    await this.gate('X-01', { action: 'ship', bundleCode: b.code });
    return true;
  }

  // The supervisor walks over a minute after the flag. An unknown defect (a
  // visitor flagged it) goes back to the collar, which is always a valid
  // place to restart.
  private async supervise(): Promise<boolean> {
    const w = await this.work('SUP');
    const now = this.clock.now().getTime();
    const b = w?.bundles.find((x) => x.flaggedAt !== undefined && now - x.flaggedAt >= this.cfg.clearAfterMs);
    if (!b) return false;
    const targetOp = DEFECT_OP[this.defects.get(b.code) ?? 'collar'];
    const r = await this.gate('SUP', { action: 'clear_rework', bundleCode: b.code, targetOp });
    if (r?.ok) {
      this.stats.clears++;
      this.forget(b.code);
    }
    return r !== null;
  }

  private async gate(station: string, body: object): Promise<{ ok: boolean; message: string } | null> {
    try {
      const r = await this.http.send('/gate/scan', { deviceId: this.gateIds.get(station), gateId: randomUUID(), ...body });
      return r.status === 200 ? r.body : null;
    } catch {
      return null;
    }
  }

  // After a clear the bundle walks the route again, so the scans and looks
  // that belonged to the old round no longer count.
  private forget(code: string): void {
    for (const set of [this.scanned, this.inspected, this.finalChecked]) {
      for (const k of set) if (k.startsWith(`${code}:`)) set.delete(k);
    }
    this.defects.delete(code);
    this.onward.delete(code);
  }

  private onResync(r: Resync): void {
    this.onward.delete(r.bundleCode);
  }

  get resyncsHandled(): number {
    return [...this.batch.values()].reduce((n, d) => n + d.resyncsHandled, 0);
  }
}

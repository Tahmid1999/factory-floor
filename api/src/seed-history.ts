import 'reflect-metadata';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppModule } from './app.module';
import { FixedClock, shareClock } from './clock';
import { dollars } from './money/close';
import { CloseService } from './money/close.service';
import { nextPeriod, periodBounds, periodOf } from './money/period';
import { pnlLines } from './money/pnl';
import { PrismaService } from './prisma.service';
import { seedLine } from './seed';
import { SimService, simConfigFromEnv } from './sim/sim.service';
import { WorkerModule } from './worker.module';

// The deploy empties the database and runs the line from here to the moment
// the run started, so October is a whole month with a real close.
const SEED_FROM = new Date('2026-10-01T00:00:00Z');
// A move costs about 17 ms of wall time here (http, the transaction, the
// worker's apply) and every tick waits ~20 ms for the worker to settle, so the
// live pace (10 moves every 30 s) took 570 s a sim-day locally, and even 1
// move every 30 s took 112 s. The budget is 1 Oct to the deploy in 25 min
// locally, about 35 s a sim-day. 5 moves every 5 min fits: October is seeded
// at about 5% of the live pace, and at the live pace around the month end.
// Around a month end the ticks are 30 s and a steady tick is cut short at the
// window's start, so 00:05 and the 23:50 to 00:20 outage fall on ticks
// whatever the steady tick is. SEED_TICK_MS and SEED_MOVES_PER_TICK override.
const SEED_TICK_MS = 300_000;
const SEED_MOVES_PER_TICK = 5;
const LIVE_MOVES_PER_MS = 1 / 3000;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// The cron closes at minute 5 of the hour; the seed does it at the same minute.
const CLOSE_AT = 5 * MIN;
// S-09 goes off the network at 23:50 on the last day and back at 00:20 on the
// 1st, so the close at 00:05 falls inside its outage.
const LATE_STATION = 'S-09';
const LATE_BEFORE = 10 * MIN;
const LATE_AFTER = 20 * MIN;
// From 23:00 on the last day to 01:00 on the 1st the line runs at the live
// pace, so the outage and the close happen with the line as busy as it is
// live and S-09 has a queue worth sending late. 120 ticks a side.
const BOUNDARY_SPAN = 60 * MIN;
const LIVE_PACE = { tickMs: 30_000, movesPerTick: 10 };

const SETTLE_POLL_MS = 5;
const SETTLE_GIVE_UP_MS = 5000;
const CLOSE_SETTLE_MS = 60_000;

export type Summary = {
  ticks: number;
  simDays: number;
  seconds: number;
  ticksPerSecond: number;
  secondsPerSimDay: number;
  bundles: number;
  postings: number;
  // Per month the run touched, every posting in it, adjustments included.
  contribution: Record<string, number>;
  closes: { period: string; wipMills: number; ms: number }[];
  // Postings booked after a close for work dated before it: S-09's outage,
  // and the scans after it that waited held until S-09's landed.
  late: number;
  // Moves per sim-hour against the live sim's, away from the month ends; 1 is
  // the same pace. Around a month end it is boundaryPace.
  pace: number;
  boundaryPace: number;
  // Ticks after which the worker had not settled within 5 s.
  unsettled: number;
};

// The run seeds the line itself, dated at its start, so any stock, money or
// bundle already there would be out of order with it.
async function refusal(prisma: PrismaClient): Promise<string | null> {
  if (process.env.SEED_MODE !== '1') return 'SEED_MODE=1 is not set; it turns the batch and gate limits off for this process';
  const counts: [string, () => Promise<number>][] = [
    ['Bundle', () => prisma.bundle.count()],
    ['Roll', () => prisma.roll.count()],
    ['StockMovement', () => prisma.stockMovement.count()],
    ['Posting', () => prisma.posting.count()],
    ['PeriodClose', () => prisma.periodClose.count()],
  ];
  for (const [table, count] of counts) {
    const n = await count();
    if (n > 0) return `the ${table} table is not empty (${n}); the seed runs once, on an emptied database`;
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The worker applies after the api has replied, so the next tick waits for
// every inbox row to have a result. Held rows have one ('held').
async function settled(prisma: PrismaClient, giveUpMs = SETTLE_GIVE_UP_MS): Promise<boolean> {
  const end = Date.now() + giveUpMs;
  for (;;) {
    if (!(await prisma.scanInbox.findFirst({ where: { result: null }, select: { id: true } }))) return true;
    if (Date.now() > end) return false;
    await sleep(SETTLE_POLL_MS);
  }
}

// A close snapshots the month, and a scan still on its way to the worker
// would land after it as a late scan that never was. So the close waits for
// the worker however long it takes, up to a minute, and stops the run if not.
export async function closeWhenSettled(
  prisma: PrismaClient,
  closer: CloseService,
  period: string,
  waitMs = CLOSE_SETTLE_MS,
): Promise<{ wipMills: number; ms: number }> {
  if (!(await settled(prisma, waitMs))) {
    throw new Error(`not closing ${period}: the worker has scans it has not settled after ${waitMs} ms`);
  }
  const t0 = performance.now();
  const out = await closer.close(period, 'seed');
  return { wipMills: out.close.wipMills, ms: Math.round(performance.now() - t0) };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

// The real sim, api and worker in one process on one stepped clock. The sim
// talks to the api over http on loopback as it does live; only time is fast.
export async function runHistory(o: {
  from: Date;
  until: () => Date;
  tickMs: number;
  movesPerTick: number;
  // The pace from 23:00 to 01:00 around each month end the run closes.
  boundary?: { tickMs: number; movesPerTick: number };
  log?: (s: string) => void;
}): Promise<Summary> {
  const dense = o.boundary ?? LIVE_PACE;
  const log = o.log ?? ((s: string) => console.log(s));
  const check = new PrismaClient();
  try {
    const why = await refusal(check);
    if (why) throw new Error(`refusing to seed: ${why}`);
    // On an emptied database this is the line and its 6 opening rolls, dated
    // when the run starts so the stock ledger reads in order.
    await seedLine(check, o.from);
  } finally {
    await check.$disconnect();
  }

  // No timer of the worker's sim, and no close on the wall clock: the run
  // closes each month itself, on the stepped clock.
  process.env.SIM_ENABLED = '0';
  process.env.CLOSE_ENABLED = '0';
  const clock = new FixedClock(o.from);
  shareClock(clock);
  let api: INestApplication | undefined;
  let worker: INestApplicationContext | undefined;
  try {
    api = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    await api.listen(0, '127.0.0.1');
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
    // The hourly purge would fire on the wall clock against a clock that is
    // weeks behind it. Nothing is old enough to go, but it would lock bundles
    // mid-tick for nothing. The 30 s sweep stays: the clock moves up to a
    // minute between moves, so a row the worker has not reached yet can look
    // 30 s old and go out twice, which apply skips, as it does live; and it
    // picks up any row an unsettled tick left behind.
    api.get(SchedulerRegistry).deleteCronJob('close');
    worker.get(SchedulerRegistry).deleteCronJob('purge');

    const prisma = api.get(PrismaService);
    const closer = api.get(CloseService);
    const port = (api.getHttpServer().address() as AddressInfo).port;
    const sim = new SimService(
      {
        ...simConfigFromEnv(process.env),
        baseUrl: `http://127.0.0.1:${port}`,
        tickMs: o.tickMs,
        movesPerTick: o.movesPerTick,
      },
      clock,
    );

    const pace = o.movesPerTick / o.tickMs / LIVE_MOVES_PER_MS;
    const boundaryPace = dense.movesPerTick / dense.tickMs / LIVE_MOVES_PER_MS;
    log(
      `seed ${stamp(o.from)} to ${stamp(o.until())} UTC · tick ${o.tickMs} ms · ${o.movesPerTick} moves` +
        (pace < 1 ? ` · seeded at about ${pct(pace)} of the live pace` : '') +
        ` · ${pct(boundaryPace)} from 23:00 to 01:00 at month ends`,
    );

    const first = periodOf(o.from);
    const closes: Summary['closes'] = [];
    const scripted = new Set<string>();
    const started = performance.now();
    let ticks = 0;
    let unsettled = 0;
    let nextDay = o.from.getTime() + DAY;

    while (clock.now() < o.until()) {
      const t = clock.now().getTime();
      const month = periodOf(clock.now());
      const { start, end } = periodBounds(month);
      const prev = periodOf(new Date(start.getTime() - 1));
      if (prev >= first && !closes.some((c) => c.period === prev) && t >= start.getTime() + CLOSE_AT) {
        const c = await closeWhenSettled(prisma, closer, prev);
        closes.push({ period: prev, ...c });
        log(`close ${prev} · wip ${dollars(c.wipMills)} · ${c.ms} ms`);
      }
      // Scripted, not drawn, and the README says so: the late scans from the
      // month before that the P&L shows are this outage.
      if (!scripted.has(month) && t >= end.getTime() - LATE_BEFORE) {
        sim.forceOffline(LATE_STATION, end.getTime() + LATE_AFTER);
        scripted.add(month);
        log(`${LATE_STATION} offline ${stamp(clock.now())} to ${stamp(new Date(end.getTime() + LATE_AFTER))}, scripted`);
      }

      // A boundary is the end of this month, or the start of it when the run
      // began before it. A slow tick never steps over the start of a window.
      const near = t >= end.getTime() - BOUNDARY_SPAN || (start > o.from && t < start.getTime() + BOUNDARY_SPAN);
      // The last tick stops at until, never past it: the live sim takes over
      // from there on the wall clock.
      const len = Math.min(
        near ? dense.tickMs : Math.min(o.tickMs, end.getTime() - BOUNDARY_SPAN - t),
        o.until().getTime() - t,
      );
      const moves = near ? dense.movesPerTick : o.movesPerTick;
      // Settled once a tick; the clock moves on between moves so the tick's
      // scans are spread over it, not stamped at its first instant.
      await sim.tick({ moves, afterMove: () => clock.advance(len / moves) });
      if (!(await settled(prisma))) {
        unsettled++;
        log(`tick ${stamp(new Date(t))}: worker not settled after ${SETTLE_GIVE_UP_MS} ms, going on; the run will exit 1`);
      }
      clock.set(new Date(t + len));
      ticks++;

      if (clock.now().getTime() >= nextDay) {
        nextDay += DAY;
        const s = ((performance.now() - started) / 1000).toFixed(1);
        log(`${stamp(clock.now())} · ${await prisma.bundle.count()} bundles · ${s} s`);
      }
    }

    // A phone still off the network would take its queue with it when this
    // process exits.
    for (const dev of sim.batch.values()) await dev.setOnline(true);
    if (!(await settled(prisma))) unsettled++;

    const seconds = (performance.now() - started) / 1000;
    const simDays = (clock.now().getTime() - o.from.getTime()) / DAY;
    const contribution: Record<string, number> = {};
    for (let p = first; p <= periodOf(clock.now()); p = nextPeriod(p)) {
      contribution[p] = (await prisma.$transaction((tx) => pnlLines(tx, p, { excludeSim: false }))).contribution;
    }
    const summary: Summary = {
      ticks,
      simDays,
      seconds,
      ticksPerSecond: ticks / seconds,
      secondsPerSimDay: simDays > 0 ? seconds / simDays : 0,
      bundles: await prisma.bundle.count(),
      postings: await prisma.posting.count(),
      contribution,
      closes,
      late: await prisma.posting.count({ where: { adjustsPeriod: { not: null } } }),
      pace,
      boundaryPace,
      unsettled,
    };
    log(
      `bundles ${summary.bundles} · postings ${summary.postings} · ` +
        Object.entries(contribution)
          .map(([p, m]) => `contribution ${p} ${dollars(m)}`)
          .join(' · ') +
        ` · ${summary.late} late · ${seconds.toFixed(1)} s · ${summary.ticksPerSecond.toFixed(1)} ticks/s · ${summary.secondsPerSimDay.toFixed(1)} s per sim-day` +
        (unsettled > 0 ? ` · ${unsettled} unsettled ticks` : ''),
    );
    return summary;
  } finally {
    await worker?.close();
    await api?.close();
    shareClock(undefined);
  }
}

async function main() {
  config({ path: resolve(__dirname, '../../.env') });
  const s = await runHistory({
    from: SEED_FROM,
    until: () => new Date(),
    tickMs: Number(process.env.SEED_TICK_MS) || SEED_TICK_MS,
    movesPerTick: Number(process.env.SEED_MOVES_PER_TICK) || SEED_MOVES_PER_TICK,
  });
  // The data may well be fine (the sweep resends), but a deploy should not
  // go on without someone looking.
  if (s.unsettled > 0) throw new Error(`${s.unsettled} ticks did not settle within ${SETTLE_GIVE_UP_MS} ms`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`seed:history: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}

import { ApiError, BatchReply, postBatch } from './api';
import { offline, onNetChange } from './net';
import { QueuedEvent, drop, dropBundle, pending, setOffset } from './queue';

const DEBOUNCE_MS = 300;
// The heartbeat also keeps the guest active on the server. A guest quiet for
// five minutes has their bundles carried on by the simulated line.
const HEARTBEAT_MS = 10_000;
// The server takes 2 batches a second per device.
const MIN_GAP_MS = 500;
const MAX_EVENTS = 50;
// A request that hangs would hold the loop for good. Giving up and resending
// is safe: the server keys every event by (deviceId, seq) and answers a
// resend as a duplicate.
const BATCH_TIMEOUT_MS = 10_000;
const BACKOFF_CAP_S = 30;

export type SyncStatus = {
  deviceId: string;
  station: string;
  pending: number;
  firstSeq: number | null;
  lastSeq: number | null;
  last: { at: number; events: number; http: number } | null;
  retry: { at: number; tryNo: number; why: string } | null;
};

export type SyncResult = {
  deviceId: string;
  station: string;
  sent: QueuedEvent[];
  reply: BatchReply;
  // Scans still waiting here for a bundle the server sent back as resync.
  flushed: QueuedEvent[];
  at: number;
};

type Handlers = { onReply(r: SyncResult): void; onStatus(s: SyncStatus): void };

// 1, 2, 4, 8, 16, 30 s, each within 20% either way so a floor of phones that
// lost the same access point does not come back in step.
function backoffMs(failures: number): number {
  const base = Math.min(BACKOFF_CAP_S, 2 ** (failures - 1)) * 1000;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

class Loop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private busy = false;
  // A scan that came in while a batch was in flight goes right after it.
  private again = false;
  private lastSentAt = 0;
  private last: SyncStatus['last'] = null;
  private retry: SyncStatus['retry'] = null;

  constructor(
    readonly deviceId: string,
    readonly station: string,
    public handlers: Handlers,
  ) {
    // Back online: no reason to sit out the rest of a 30 s backoff.
    onNetChange(() => {
      if (this.failures > 0 && !offline(this.station)) this.schedule(0);
    });
    // Whatever survived a reload goes at once.
    this.schedule(0);
  }

  kick() {
    if (this.busy) {
      this.again = true;
      return;
    }
    // In backoff the next try is already booked; a new scan only joins it.
    if (this.failures > 0) {
      void this.publish();
      return;
    }
    this.schedule(DEBOUNCE_MS);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(ms, this.lastSentAt + MIN_GAP_MS - Date.now());
    this.timer = setTimeout(() => void this.run(), wait);
  }

  private async run() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.again = false;
    let next = HEARTBEAT_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), BATCH_TIMEOUT_MS);
    try {
      const events = (await pending(this.deviceId)).slice(0, MAX_EVENTS);
      const t0 = Date.now();
      this.lastSentAt = t0;
      const wire = events.map(({ seq, bundleCode, op, scannedAt, offsetMs }) => ({ seq, bundleCode, op, scannedAt, offsetMs }));
      const res = await postBatch({ deviceId: this.deviceId, deviceNow: t0, events: wire }, this.station, ctl.signal);
      const t1 = Date.now();
      if (res.status !== 201) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? `http ${res.status}`);
      }
      const reply = (await res.json()) as BatchReply;
      // The server's clock at the middle of the round trip, against ours.
      await setOffset(Math.round(reply.serverNow - (t0 + t1) / 2));
      await drop(
        this.deviceId,
        reply.results.map((r) => r.seq),
      );
      const flushed: QueuedEvent[] = [];
      // Notices repeat with their resync for a minute, so a bundle back in work
      // here may already be in a new round with scans of its own queued.
      for (const r of reply.resync) {
        const below = r.status === 'rework' || r.status === 'scrapped' ? undefined : r.round;
        flushed.push(...(await dropBundle(this.deviceId, r.bundleCode, below)));
      }
      this.failures = 0;
      this.retry = null;
      this.last = { at: t1, events: events.length, http: res.status };
      this.handlers.onReply({ deviceId: this.deviceId, station: this.station, sent: events, reply, flushed, at: t1 });
    } catch (e) {
      this.failures += 1;
      next = backoffMs(this.failures);
      const why =
        e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).name === 'AbortError' ? 'timeout' : 'no network';
      this.retry = { at: Date.now() + next, tryNo: this.failures + 1, why };
    } finally {
      clearTimeout(timer);
      const left = await this.publish();
      if (this.failures === 0 && (this.again || left > 0)) next = 0;
      this.busy = false;
      this.schedule(next);
    }
  }

  async publish(): Promise<number> {
    const p = await pending(this.deviceId);
    this.handlers.onStatus({
      deviceId: this.deviceId,
      station: this.station,
      pending: p.length,
      firstSeq: p[0]?.seq ?? null,
      lastSeq: p[p.length - 1]?.seq ?? null,
      last: this.last,
      retry: this.retry,
    });
    return p.length;
  }
}

const loops = new Map<string, Loop>();

// One loop per device for the life of the page. Calling it again for the same
// device hands the running loop new handlers instead of starting a second one.
export function startSync(deviceId: string, station: string, handlers: Handlers): { kick(): void } {
  let loop = loops.get(deviceId);
  if (loop) loop.handlers = handlers;
  else {
    loop = new Loop(deviceId, station, handlers);
    loops.set(deviceId, loop);
  }
  return loop;
}

export function kick(deviceId: string) {
  loops.get(deviceId)?.kick();
}

import { Clock } from '../clock';

export type HttpReply = { status: number; body: any };
export type Send = (path: string, body: unknown) => Promise<HttpReply>;
export type Resync = { bundleCode: string; status: string; nextOp: string | null; round: number };

type QueuedEvent = { seq: number; bundleCode: string; op: string; scannedAt: number; offsetMs: number };

const MAX_EVENTS = 50;

// A batch station as a phone behaves: scans queue in memory, go out at once
// while online, and wait while offline. It keeps no state that a real phone
// would not have; the server's reply is the only thing it learns from.
export class SimDevice {
  online = true;
  offsetMs = 0;
  resyncsHandled = 0;

  private queue: QueuedEvent[] = [];
  // Seqs start at 1 per process, like a phone's first day.
  private seq = 0;
  private flushing: Promise<void> | null = null;

  readonly deviceId: string;
  readonly station: string;
  private readonly send: Send;
  private readonly clock: Clock;
  private readonly onResync?: (r: Resync) => void;

  constructor(o: { deviceId: string; station: string; send: Send; clock: Clock; onResync?: (r: Resync) => void }) {
    this.deviceId = o.deviceId;
    this.station = o.station;
    this.send = o.send;
    this.clock = o.clock;
    this.onResync = o.onResync;
  }

  get pending(): number {
    return this.queue.length;
  }

  isQueued(bundleCode: string): boolean {
    return this.queue.some((e) => e.bundleCode === bundleCode);
  }

  async scan(bundleCode: string, op: string): Promise<void> {
    this.queue.push({
      seq: ++this.seq,
      bundleCode,
      op,
      scannedAt: this.clock.now().getTime(),
      offsetMs: this.offsetMs,
    });
    await this.flush();
  }

  // Coming back online sends everything that waited, in one batch per 50.
  async setOnline(online: boolean): Promise<void> {
    this.online = online;
    if (online) await this.flush();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.online && this.queue.length > 0) {
      const events = this.queue.slice(0, MAX_EVENTS);
      const deviceNow = this.clock.now().getTime();
      let reply: HttpReply;
      try {
        reply = await this.send('/scans/batch', { deviceId: this.deviceId, deviceNow, events });
      } catch {
        return;
      }
      // A 429 or any other failure leaves the queue as it was; the same seqs
      // go out again, which the server answers as duplicates if they landed.
      if (reply.status !== 201) return;
      const answered = this.handle(reply.body, deviceNow);
      // Something the server did not answer stays for the next flush rather
      // than being resent in a tight loop.
      if (answered < events.length) return;
    }
  }

  private handle(body: { serverNow: number; results: { seq: number }[]; resync: Resync[] }, deviceNow: number): number {
    this.offsetMs = body.serverNow - deviceNow;
    // Accepted, duplicate and rejected are all final for the seq: the station
    // would show a rejection, and nothing is ever resent under a new seq.
    const answered = new Set(body.results.map((r) => r.seq));
    this.queue = this.queue.filter((e) => !answered.has(e.seq));
    // The bundle moved on without this scan (rework, scrap), so whatever else
    // is queued for it is stale too.
    for (const r of body.resync) {
      this.queue = this.queue.filter((e) => e.bundleCode !== r.bundleCode);
      this.resyncsHandled++;
      this.onResync?.(r);
    }
    return answered.size;
  }
}

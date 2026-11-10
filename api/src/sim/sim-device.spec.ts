import { FixedClock } from '../clock';
import { SimDevice } from './sim-device';

type Body = { deviceId: string; deviceNow: number; events: { seq: number; bundleCode: string; op: string; offsetMs: number }[] };
type Call = { path: string; body: Body };

const acceptAll = (events: { seq: number }[], serverNow = 0) => ({
  serverNow,
  results: events.map((e) => ({ seq: e.seq, result: 'accepted' })),
  resync: [],
  notices: [],
});

// A server that accepts everything, unless a reply is supplied.
function fakeSend(reply?: (c: Call) => unknown) {
  const calls: Call[] = [];
  const send = async (path: string, body: unknown) => {
    const call = { path, body } as Call;
    calls.push(call);
    return { status: 201, body: reply ? reply(call) : acceptAll(call.body.events) };
  };
  return { calls, send };
}

const T0 = new Date('2026-11-09T10:00:00Z');
const make = (send: ConstructorParameters<typeof SimDevice>[0]['send'], extra: object = {}, clock = new FixedClock(T0)) =>
  new SimDevice({ deviceId: 'd1', station: 'S-07', send, clock, ...extra });

describe('SimDevice', () => {
  it('keeps scans while offline and sends them as one batch with consecutive seqs when back online', async () => {
    const { calls, send } = fakeSend();
    const clock = new FixedClock(T0);
    const dev = make(send, {}, clock);

    dev.online = false;
    await dev.scan('B-8492', 'sew_collar');
    clock.advance(3000);
    await dev.scan('B-8493', 'sew_collar');
    clock.advance(3000);
    await dev.scan('B-8494', 'sew_collar');
    expect(calls).toHaveLength(0);
    expect(dev.pending).toBe(3);

    await dev.setOnline(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/scans/batch');
    expect(calls[0].body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(calls[0].body.events.map((e) => e.bundleCode)).toEqual(['B-8492', 'B-8493', 'B-8494']);
    expect(dev.pending).toBe(0);
  });

  it('numbers its scans on from the last seq the server holds', async () => {
    const { calls, send } = fakeSend();
    const dev = make(send, { lastSeq: 41 });
    await dev.scan('B-8492', 'sew_collar');
    await dev.scan('B-8493', 'sew_collar');
    expect(calls.flatMap((c) => c.body.events.map((e) => e.seq))).toEqual([42, 43]);
  });

  it('sends right after a scan while online', async () => {
    const { calls, send } = fakeSend();
    const dev = make(send);
    await dev.scan('B-8492', 'sew_collar');
    await dev.scan('B-8493', 'sew_collar');
    expect(calls.map((c) => c.body.events.map((e) => e.seq))).toEqual([[1], [2]]);
  });

  it('drops accepted, duplicate and rejected seqs but keeps what the server did not answer', async () => {
    const { calls, send } = fakeSend((c) => ({
      serverNow: 0,
      results: [
        { seq: c.body.events[0].seq, result: 'duplicate' },
        { seq: c.body.events[1].seq, result: 'rejected', reason: 'clock' },
      ],
      resync: [],
      notices: [],
    }));
    const dev = make(send);
    dev.online = false;
    for (const code of ['B-1', 'B-2', 'B-3']) await dev.scan(code, 'sew_collar');
    await dev.setOnline(true);
    expect(dev.pending).toBe(1);
    await dev.flush();
    expect(calls[1].body.events.map((e) => e.seq)).toEqual([3]);
  });

  it('keeps the queue when the server cannot be reached', async () => {
    let up = false;
    const send = async (_p: string, body: unknown) => {
      if (!up) throw new Error('connection refused');
      return { status: 201, body: acceptAll((body as Body).events) };
    };
    const dev = make(send);
    await dev.scan('B-1', 'sew_collar');
    expect(dev.pending).toBe(1);
    up = true;
    await dev.flush();
    expect(dev.pending).toBe(0);
  });

  it('keeps the queue on a 429 and resends the same seq', async () => {
    let status = 429;
    const seen: number[][] = [];
    const send = async (_p: string, body: unknown) => {
      const events = (body as Body).events;
      seen.push(events.map((e) => e.seq));
      return { status, body: status === 429 ? { error: 'slow down' } : acceptAll(events) };
    };
    const dev = make(send);
    await dev.scan('B-1', 'sew_collar');
    status = 201;
    await dev.flush();
    expect(seen).toEqual([[1], [1]]);
  });

  it('drops queued events for a bundle the server says moved on, and tells the owner', async () => {
    const resynced: string[] = [];
    const { send } = fakeSend((c) => ({
      serverNow: 0,
      results: c.body.events.slice(0, 1).map((e) => ({ seq: e.seq, result: 'rejected', reason: 'rework' })),
      resync: [{ bundleCode: 'B-1', status: 'rework', nextOp: 'sew_sleeve', round: 0 }],
      notices: [],
    }));
    const dev = make(send, { onResync: (r: { bundleCode: string }) => resynced.push(r.bundleCode) });
    dev.online = false;
    await dev.scan('B-1', 'sew_sleeve');
    await dev.scan('B-1', 'side_seam');
    await dev.scan('B-2', 'sew_sleeve');
    await dev.setOnline(true);
    expect(resynced).toEqual(['B-1']);
    expect(dev.resyncsHandled).toBe(1);
    // B-1's second event was dropped without ever being sent; B-2 is still owed.
    expect(dev.pending).toBe(1);
  });

  it('stores the clock offset from serverNow and uses it on the next scan', async () => {
    const { calls, send } = fakeSend((c) => acceptAll(c.body.events, T0.getTime() + 7000));
    const dev = make(send);
    await dev.scan('B-1', 'sew_collar');
    expect(dev.offsetMs).toBe(7000);
    await dev.scan('B-2', 'sew_collar');
    expect(calls[1].body.events[0].offsetMs).toBe(7000);
  });

  it('splits a long queue into batches of at most 50', async () => {
    const { calls, send } = fakeSend();
    const dev = make(send);
    dev.online = false;
    for (let i = 0; i < 120; i++) await dev.scan(`B-${i}`, 'sew_collar');
    await dev.setOnline(true);
    expect(calls.map((c) => c.body.events.length)).toEqual([50, 50, 20]);
  });
});

import { DBSchema, IDBPDatabase, openDB } from 'idb';

// The station's own storage. Scans live here until the server has answered
// for them, so closing the tab or losing power loses nothing.

export type QueuedEvent = {
  deviceId: string;
  seq: number;
  bundleCode: string;
  op: string;
  scannedAt: number;
  offsetMs: number;
};

// The operator's tally of work done on this phone, kept apart from the queue
// because it outlives the sync: a scan leaves the queue once it is accepted
// and stays in the tally until the end of the day.
export type WorkRow = {
  deviceId: string;
  seq: number;
  bundleCode: string;
  op: string;
  station: string;
  mills: number;
  at: number;
};

interface StationDb extends DBSchema {
  events: { key: [string, number]; value: QueuedEvent };
  seqs: { key: string; value: number };
  work: { key: [string, number]; value: WorkRow };
  meta: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<StationDb>> | null = null;

function db() {
  dbp ??= openDB<StationDb>('ff-station', 1, {
    upgrade(d) {
      d.createObjectStore('events', { keyPath: ['deviceId', 'seq'] });
      d.createObjectStore('seqs');
      d.createObjectStore('work', { keyPath: ['deviceId', 'seq'] });
      d.createObjectStore('meta');
    },
  });
  return dbp;
}

const ofDevice = (deviceId: string) => IDBKeyRange.bound([deviceId, 0], [deviceId, Number.MAX_SAFE_INTEGER]);

// The counter and the event go in one transaction, so two quick taps cannot
// take the same seq and a crash between them cannot skip one.
export async function enqueue(deviceId: string, e: Omit<QueuedEvent, 'deviceId' | 'seq'>): Promise<number> {
  const tx = (await db()).transaction(['seqs', 'events'], 'readwrite');
  const seq = ((await tx.objectStore('seqs').get(deviceId)) ?? 0) + 1;
  await tx.objectStore('seqs').put(seq, deviceId);
  await tx.objectStore('events').put({ ...e, deviceId, seq });
  await tx.done;
  return seq;
}

export async function pending(deviceId: string): Promise<QueuedEvent[]> {
  return (await db()).getAll('events', ofDevice(deviceId));
}

export async function pendingAll(): Promise<QueuedEvent[]> {
  return (await db()).getAll('events');
}

export async function drop(deviceId: string, seqs: number[]): Promise<void> {
  const tx = (await db()).transaction('events', 'readwrite');
  await Promise.all(seqs.map((s) => tx.store.delete([deviceId, s])));
  await tx.done;
}

// The poisoned-queue flush: once the server says a bundle went to rework,
// every scan of it still waiting here was made on a bad bundle and would only
// be rejected one by one.
export async function dropBundle(deviceId: string, bundleCode: string): Promise<QueuedEvent[]> {
  const tx = (await db()).transaction('events', 'readwrite');
  const gone = (await tx.store.getAll(ofDevice(deviceId))).filter((e) => e.bundleCode === bundleCode);
  await Promise.all(gone.map((e) => tx.store.delete([deviceId, e.seq])));
  await tx.done;
  return gone;
}

export async function getOffset(): Promise<number> {
  return ((await (await db()).get('meta', 'offset')) as number | undefined) ?? 0;
}

export async function setOffset(ms: number): Promise<void> {
  await (await db()).put('meta', ms, 'offset');
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await (await db()).put('meta', value, key);
}

// A step is paid once per bundle, whatever the round, so a redo after rework
// is recorded at $0.00. The server applies the same rule to the posting.
export async function addWork(row: Omit<WorkRow, 'mills'>, fullMills: number): Promise<number> {
  const tx = (await db()).transaction('work', 'readwrite');
  const paid = (await tx.store.getAll()).some((w) => w.bundleCode === row.bundleCode && w.op === row.op && w.mills > 0);
  const mills = paid ? 0 : fullMills;
  await tx.store.put({ ...row, mills });
  await tx.done;
  return mills;
}

export async function dropWork(deviceId: string, seqs: number[]): Promise<void> {
  const tx = (await db()).transaction('work', 'readwrite');
  await Promise.all(seqs.map((s) => tx.store.delete([deviceId, s])));
  await tx.done;
}

export async function workSince(t: number): Promise<WorkRow[]> {
  return (await (await db()).getAll('work')).filter((w) => w.at >= t);
}

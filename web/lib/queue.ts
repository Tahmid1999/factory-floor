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
  // The bundle's rework round as the station knew it at the scan. Not sent:
  // it only decides which queued scans a resync makes stale.
  round: number;
};

export type Unseen = { seq: number; bundleCode: string; reason: string };

// The operator's tally of work done on this phone, kept apart from the queue
// because it outlives the sync: a scan leaves the queue once it is accepted
// and stays in the tally until the end of the day.
export type WorkRow = {
  deviceId: string;
  seq: number;
  bundleCode: string;
  op: string;
  station: string;
  pieces: number;
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
// take the same seq and a crash between them cannot skip one. With no counter
// at all the seq is unknown, not 0: the server may already hold seqs for this
// device, so the caller must floor it from the server first.
export async function enqueue(deviceId: string, e: Omit<QueuedEvent, 'deviceId' | 'seq'>): Promise<number> {
  const tx = (await db()).transaction(['seqs', 'events'], 'readwrite');
  const last = await tx.objectStore('seqs').get(deviceId);
  if (last === undefined) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error(`no seq counter for ${deviceId}`);
  }
  const seq = last + 1;
  await tx.objectStore('seqs').put(seq, deviceId);
  await tx.objectStore('events').put({ ...e, deviceId, seq });
  await tx.done;
  return seq;
}

export async function hasSeq(deviceId: string): Promise<boolean> {
  return (await (await db()).get('seqs', deviceId)) !== undefined;
}

// Never moves the counter back: the server's last seq only raises it.
export async function floorSeq(deviceId: string, lastSeq: number): Promise<void> {
  const tx = (await db()).transaction('seqs', 'readwrite');
  await tx.store.put(Math.max((await tx.store.get(deviceId)) ?? 0, lastSeq), deviceId);
  await tx.done;
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
// be rejected one by one. With belowRound only scans from an earlier round go;
// one made after the clear belongs to the new round and must stay.
export async function dropBundle(deviceId: string, bundleCode: string, belowRound?: number): Promise<QueuedEvent[]> {
  const tx = (await db()).transaction('events', 'readwrite');
  const gone = (await tx.store.getAll(ofDevice(deviceId))).filter(
    (e) => e.bundleCode === bundleCode && (belowRound === undefined || (e.round ?? 0) < belowRound),
  );
  await Promise.all(gone.map((e) => tx.store.delete([deviceId, e.seq])));
  await tx.done;
  return gone;
}

// Rejections a station has not been looked at since, per device. They stay
// until the operator opens that station, across reloads.
export async function addUnseen(deviceId: string, items: Unseen[]): Promise<Record<string, Unseen[]>> {
  const all = ((await getMeta<Record<string, Unseen[]>>('unseen')) ?? {}) as Record<string, Unseen[]>;
  all[deviceId] = [...(all[deviceId] ?? []), ...items].slice(-50);
  await setMeta('unseen', all);
  return all;
}

export async function takeUnseen(deviceId: string): Promise<{ taken: Unseen[]; all: Record<string, Unseen[]> }> {
  const all = ((await getMeta<Record<string, Unseen[]>>('unseen')) ?? {}) as Record<string, Unseen[]>;
  const taken = all[deviceId] ?? [];
  delete all[deviceId];
  await setMeta('unseen', all);
  return { taken, all };
}

export async function allUnseen(): Promise<Record<string, Unseen[]>> {
  return (await getMeta<Record<string, Unseen[]>>('unseen')) ?? {};
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

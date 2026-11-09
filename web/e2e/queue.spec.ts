import 'fake-indexeddb/auto';
import { expect, test } from '@playwright/test';
import { dropBundle, enqueue, floorSeq, pending } from '../lib/queue';
import { SyncResult, SyncStatus, startSync } from '../lib/sync';

// No browser here: the queue and the sync loop run in Node against an
// in-memory IndexedDB, with fetch replaced, so the cases that a real server
// will not produce on cue can be set up exactly.

const scan = (bundleCode: string, round: number) => ({
  bundleCode,
  op: 'sew_sleeve',
  scannedAt: Date.now(),
  offsetMs: 0,
  round,
});

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a device with no seq counter cannot enqueue, and the server floor only raises it', async () => {
  await expect(enqueue('dev-a', scan('B-1', 0))).rejects.toThrow('no seq counter');
  await floorSeq('dev-a', 5);
  await floorSeq('dev-a', 2);
  expect(await enqueue('dev-a', scan('B-1', 0))).toBe(6);
});

test('a resync of a bundle back in work flushes only scans from the round before', async () => {
  await floorSeq('dev-b', 0);
  await enqueue('dev-b', scan('B-2', 0));
  await enqueue('dev-b', scan('B-2', 1));
  expect((await dropBundle('dev-b', 'B-2', 1)).map((e) => e.seq)).toEqual([1]);
  expect((await pending('dev-b')).map((e) => e.seq)).toEqual([2]);
  expect((await dropBundle('dev-b', 'B-2')).map((e) => e.seq)).toEqual([2]);
});

test('the sync loop keeps a new-round scan the server did not answer for yet', async () => {
  await floorSeq('dev-c', 0);
  await enqueue('dev-c', scan('B-3', 0));
  await enqueue('dev-c', scan('B-3', 1));
  // The reply answers neither scan but carries the minute-long resync of a
  // bundle that has since been cleared into round 1.
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        serverNow: Date.now(),
        results: [],
        resync: [{ bundleCode: 'B-3', status: 'active', nextOp: 'sew_sleeve', round: 1 }],
        notices: [],
      }),
      { status: 201 },
    );
  const reply = new Promise<SyncResult>((onReply) => startSync('dev-c', 'S-08', { onReply, onStatus: () => undefined }));
  expect((await reply).flushed.map((e) => e.seq)).toEqual([1]);
  expect((await pending('dev-c')).map((e) => e.seq)).toEqual([2]);
});

test('a batch that hangs is given up after 10 s and goes into backoff', async () => {
  test.setTimeout(30_000);
  await floorSeq('dev-d', 0);
  await enqueue('dev-d', scan('B-4', 0));
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const started = Date.now();
  const status = await new Promise<SyncStatus>((resolve) =>
    startSync('dev-d', 'S-08', {
      onReply: () => undefined,
      onStatus: (s) => {
        if (s.retry) resolve(s);
      },
    }),
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(9_900);
  expect(status.retry).toMatchObject({ tryNo: 2, why: 'timeout' });
  expect(status.pending).toBe(1);
});

import { Page, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { closeGuests, flash, guestPage, row, scanButton, watchBatches } from './helpers';

test.afterAll(closeGuests);

test('a scan at S-07 is green at once and leaves the queue within 2 s', async ({ browser }) => {
  const page = await guestPage(browser);
  await expect(scanButton(page)).toBeEnabled();

  // Timed inside the page, from the click to the flash turning green, so
  // Playwright's own round trips are not counted.
  const ms = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const box = document.querySelector('[role=status]')!;
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan next bundle')!;
        const t0 = performance.now();
        const obs = new MutationObserver(() => {
          if (box.getAttribute('data-tone') === 'ok') {
            obs.disconnect();
            resolve(performance.now() - t0);
          }
        });
        obs.observe(box, { attributes: true });
        button.click();
      }),
  );
  expect(ms).toBeLessThan(100);
  await expect(flash(page)).toContainText(/B-\d+ · sew_collar · \d+ ms/);
  await expect(row(page, 'last sync')).toContainText('· 1 events · 201', { timeout: 2000 });
  await expect(row(page, 'pending')).toHaveText('0');
});

test('with the wifi off scans queue, and one batch drains them when it is back', async ({ browser }) => {
  const page = await guestPage(browser);
  const batches = watchBatches(page);
  await expect(scanButton(page)).toBeEnabled();

  await page.getByRole('button', { name: 'wifi on' }).click();
  for (let i = 0; i < 3; i++) await scanButton(page).click();
  await expect(row(page, 'pending')).toHaveText('3');
  await expect(flash(page)).toContainText('queued locally');
  await expect(row(page, 'next retry')).toHaveText(/^in \d+ s \(try \d+\)$/);
  expect(batches.seqs).toEqual([]);

  await page.getByRole('button', { name: 'wifi off' }).click();
  await expect(row(page, 'pending')).toHaveText('0', { timeout: 5000 });
  await expect(row(page, 'last sync')).toContainText('· 3 events · 201');
  expect(batches.seqs).toEqual([[1, 2, 3]]);
});

test('a reload keeps the queue, and it drains afterwards', async ({ browser }) => {
  const page = await guestPage(browser);
  const batches = watchBatches(page);
  await expect(scanButton(page)).toBeEnabled();

  await page.getByRole('button', { name: 'wifi on' }).click();
  await scanButton(page).click();
  await scanButton(page).click();
  await expect(row(page, 'pending')).toHaveText('2');

  await page.reload();
  await expect(page.getByRole('button', { name: 'wifi off' })).toBeVisible();
  await expect(row(page, 'pending')).toHaveText('2');
  await expect(row(page, 'queue')).toHaveText('IndexedDB · seq 1-2');

  await page.getByRole('button', { name: 'wifi off' }).click();
  await expect(row(page, 'pending')).toHaveText('0', { timeout: 5000 });
  // The third bundle: the seq carries on from before the reload.
  await scanButton(page).click();
  await expect(row(page, 'last sync')).toContainText('· 1 events · 201', { timeout: 2000 });
  expect(batches.seqs).toEqual([[1, 2], [3]]);
});

// The batch reply to the first scan sent after this call, read from the wire.
function nextScanReply(page: Page) {
  return page.waitForResponse((r) => {
    if (!r.url().endsWith('/scans/batch') || r.request().method() !== 'POST') return false;
    return (JSON.parse(r.request().postData() ?? '{}').events ?? []).length > 0;
  });
}

test('a wiped seq counter carries on above the last seq the server holds', async ({ browser }) => {
  const page = await guestPage(browser);
  await expect(scanButton(page)).toBeEnabled();
  const first = nextScanReply(page);
  await scanButton(page).click();
  expect((await (await first).json()).results).toEqual([{ seq: 1, result: 'accepted' }]);

  // The device id stays cached; only the counter is lost.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('ff-station');
        open.onsuccess = () => {
          const tx = open.result.transaction('seqs', 'readwrite');
          tx.objectStore('seqs').clear();
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  await expect(scanButton(page)).toBeEnabled();
  const second = nextScanReply(page);
  await scanButton(page).click();
  expect((await (await second).json()).results).toEqual([{ seq: 2, result: 'accepted' }]);
});

test('a rejection at a station I am not on waits as a badge until I open it', async ({ browser }) => {
  const page = await guestPage(browser);
  const picker = (s: string) => page.getByRole('group', { name: 'station' }).getByRole('button', { name: new RegExp(`^${s}`) });
  await expect(scanButton(page)).toBeEnabled();
  await scanButton(page).click();
  const api = 'http://localhost:4120';
  await expect(flash(page)).toContainText('sew_collar');
  const code = (await flash(page).textContent())!.match(/B-\d+/)![0];
  const nextOp = async () =>
    (await (await page.request.get(`${api}/me`)).json()).bundles.find((b: { code: string }) => b.code === code).nextOp;
  await expect.poll(nextOp).toBe('sew_sleeve');

  // S-08 sews it offline, and I walk back to S-07.
  await picker('S-08').click();
  await expect(scanButton(page)).toBeEnabled();
  await page.getByRole('button', { name: 'wifi on' }).click();
  await scanButton(page).click();
  await expect(row(page, 'pending')).toHaveText('1');
  await picker('S-07').click();

  // Meanwhile QC flags it, from another device.
  const q01 = await (await page.request.post(`${api}/devices`, { data: { station: 'Q-01' } })).json();
  const flag = await page.request.post(`${api}/gate/scan`, {
    data: { deviceId: q01.deviceId, gateId: randomUUID(), bundleCode: code, action: 'qc_flag', defect: 'collar' },
  });
  expect((await flag.json()).ok).toBe(true);

  await page.getByRole('button', { name: 'wifi off' }).click();
  await expect(picker('S-08').locator('.badge')).toHaveText('1', { timeout: 5000 });
  await expect(row(page, 'rejected elsewhere')).toHaveText('S-08 1');
  await expect(flash(page)).not.toContainText('RESYNC');

  // A reload keeps it, and opening S-08 shows it and clears the badge.
  await page.reload();
  await expect(picker('S-08').locator('.badge')).toHaveText('1');
  await picker('S-08').click();
  await expect(flash(page)).toContainText('RESYNC');
  await expect(flash(page)).toContainText('1 scan rejected while you were away');
  await expect(flash(page)).toContainText(`${code} · rework`);
  await expect(page.locator('.badge')).toHaveCount(0);
});

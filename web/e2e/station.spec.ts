import { expect, test } from '@playwright/test';
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

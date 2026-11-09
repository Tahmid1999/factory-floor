import { Page, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { closeGuests, flash, guestPage, scanButton, stationLabel } from './helpers';

test.afterAll(closeGuests);

const api = path.resolve(__dirname, '../../api');
const { PrismaClient } = createRequire(path.join(api, 'package.json'))('@prisma/client');

// The visitor reads every line of the trap on screen; the money behind the
// redo is checked in the database as well, since the screen keeps its own tally.
async function collarPostings(code: string): Promise<number[]> {
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  try {
    const rows: { amountMills: number }[] = await db.$queryRaw`
      SELECT p."amountMills" FROM "Posting" p JOIN "BundleEvent" e ON e."id" = p."eventId"
      WHERE p."bundleCode" = ${code} AND p."kind" = 'labour' AND e."op" = 'sew_collar'`;
    return rows.map((r) => r.amountMills);
  } finally {
    await db.$disconnect();
  }
}

async function startTrap(page: Page) {
  await expect(scanButton(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Run the QC trap' }).click();
  await expect(page.getByRole('button', { name: 'defect: collar' })).toBeEnabled({ timeout: 15_000 });
  await expect(stationLabel(page)).toHaveText('Q-01 · inline QC');
}

test.describe.serial('all async, then the clear', () => {
  let page: Page;

  test.beforeAll(() => {
    // A clean factory_test, so this visitor's first bundle is B-8492.
    execFileSync('node', [path.join(__dirname, 'reset-db.cjs')], { stdio: 'inherit' });
  });

  test('all async: the flag lands after the sleeve and $0.53 is wasted', async ({ browser }) => {
    page = await guestPage(browser);
    await page.getByRole('button', { name: 'all async' }).click();
    await startTrap(page);

    await page.getByRole('button', { name: 'defect: collar' }).click();
    await expect(page.getByRole('button', { name: 'wifi: dropped (scenario)' })).toBeDisabled();
    await expect(flash(page)).toContainText('B-8492 · queued locally');

    const sleeve = page.getByRole('button', { name: 'scan B-8492 at S-08' });
    await expect(sleeve).toBeEnabled();
    await sleeve.click();
    await expect(stationLabel(page)).toHaveText('S-08 · sew sleeve');
    await expect(page.getByTestId('trap-result')).toHaveText('sleeve sewn on a rework bundle · $0.53 wasted', {
      timeout: 30_000,
    });
  });

  test('the clear leaves B-8492 at S-07 and the redone collar is paid $0.00', async () => {
    await page.getByRole('button', { name: 'clear rework → sew_collar' }).click();
    await expect(page.getByText('B-8492 back at S-07 · round 1')).toBeVisible();
    await expect(stationLabel(page)).toHaveText('S-07 · sew collar');

    await page.getByRole('button', { name: 'redo collar at S-07' }).click();
    await expect(page.getByTestId('trap-redo')).toHaveText('$0.00 · rework, not paid again');
    await expect(page.locator('[data-row="last sync"]')).toContainText('· 1 events · 201', { timeout: 3000 });
    // One collar posting for the bundle, from round 0; the redo posted nothing.
    await expect.poll(() => collarPostings('B-8492'), { timeout: 5000 }).toEqual([300]);
  });
});

test('hybrid: QC holds the bundle, S-08 is resynced and nothing is wasted', async ({ browser }) => {
  const page = await guestPage(browser);
  await startTrap(page);
  const sleeve = page.getByRole('button', { name: /^scan B-\d+ at S-08$/ });

  await page.getByRole('button', { name: 'defect: collar' }).click();
  await expect(flash(page)).toContainText('STOP');
  await expect(flash(page)).toContainText('no network · bundle held at QC');
  await expect(sleeve).toBeDisabled();
  await page.waitForTimeout(1500);
  await expect(sleeve).toBeDisabled();

  // The drop ends and the held flag goes through as a live gate call.
  await expect(flash(page)).toContainText(/B-\d+ in rework · send back to S-07/, { timeout: 8000 });
  await expect(sleeve).toBeEnabled();

  await sleeve.click();
  await expect(flash(page)).toContainText('RESYNC', { timeout: 5000 });
  await expect(flash(page)).toContainText('1 scan rejected');
  await expect(page.getByTestId('trap-result')).toHaveText(/^stopped at S-08 in \d+\.\d s · \$0\.00 wasted$/);
});

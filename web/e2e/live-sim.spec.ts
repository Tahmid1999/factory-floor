import { APIRequestContext, Page, expect, request, test } from '@playwright/test';
import { closeGuests, flash, guestPage, scanButton, stationLabel } from './helpers';

// The trap as a visitor meets it in production: the simulated line is
// running beside them, cutting, sewing, flagging and clearing its own
// bundles. None of that may touch the visitor's bundle mid-trap, or the waste
// reads the sim's side seam as the visitor's and the clear finds nothing to
// clear. Run with playwright.sim.config.ts.

test.afterAll(closeGuests);

const SIM_STATIONS = ['S-09', 'S-10', 'Q-01', 'Q-02', 'SUP'];

// What the sim is offered, asked the way the sim asks it, all through the
// trap: the visitor's bundle must never be on the list. The waste and the
// clear below are the visible effect; this is the cause, checked directly so
// the test does not hang on the sim happening to reach for it in time.
function watchSimWork(code: () => string | null) {
  let sim: APIRequestContext | undefined;
  let stop = false;
  const offered: string[] = [];
  const done = (async () => {
    sim = await request.newContext({
      baseURL: 'http://127.0.0.1:4120',
      extraHTTPHeaders: { 'x-sim-key': process.env.SIM_KEY! },
    });
    while (!stop) {
      const c = code();
      for (const station of c ? SIM_STATIONS : []) {
        const r = await sim.get(`/sim/work?station=${station}`);
        const listed = ((await r.json()).bundles ?? []) as { code: string }[];
        if (listed.some((b) => b.code === c)) offered.push(station);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    await sim.dispose();
  })();
  return {
    async end() {
      stop = true;
      await done;
      return offered;
    },
  };
}

async function startTrap(page: Page): Promise<string> {
  await expect(scanButton(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Run the QC trap' }).click();
  await expect(page.getByRole('button', { name: 'defect: collar' })).toBeEnabled({ timeout: 15_000 });
  await expect(stationLabel(page)).toHaveText('Q-01 · inline QC');
  const sleeve = await page.getByRole('button', { name: /^scan B-\d+ at S-08$/ }).textContent();
  return /B-\d+/.exec(sleeve ?? '')![0];
}

async function clearAndRedo(page: Page, code: string) {
  await page.getByRole('button', { name: 'clear rework → sew_collar' }).click();
  await expect(page.getByText(`${code} back at S-07 · round 1`)).toBeVisible();
  await page.getByRole('button', { name: 'redo sew_collar at S-07' }).click();
  await expect(page.getByTestId('trap-redo')).toHaveText('$0.00 · rework, not paid again', { timeout: 15_000 });
}

test('all async beside the live line: $0.53 wasted, and the visitor clears it', async ({ browser }) => {
  const page = await guestPage(browser);
  await page.getByRole('button', { name: 'all async' }).click();
  let watched: string | null = null;
  const watch = watchSimWork(() => watched);
  const code = await startTrap(page);
  watched = code;

  await page.getByRole('button', { name: 'defect: collar' }).click();
  await expect(flash(page)).toContainText(`${code} · queued locally`);
  await page.getByRole('button', { name: `scan ${code} at S-08` }).click();
  await expect(page.getByTestId('trap-result')).toHaveText('sleeve sewn on a rework bundle · $0.53 wasted', {
    timeout: 30_000,
  });
  await clearAndRedo(page, code);
  expect(await watch.end()).toEqual([]);
});

test('hybrid beside the live line: $0.00 wasted, and the visitor clears it', async ({ browser }) => {
  const page = await guestPage(browser);
  let watched: string | null = null;
  const watch = watchSimWork(() => watched);
  const code = await startTrap(page);
  watched = code;
  const sleeve = page.getByRole('button', { name: `scan ${code} at S-08` });

  await page.getByRole('button', { name: 'defect: collar' }).click();
  await expect(flash(page)).toContainText(`${code} in rework · send back to S-07`, { timeout: 8000 });
  await expect(sleeve).toBeEnabled();
  await sleeve.click();
  await expect(page.getByTestId('trap-result')).toHaveText(/^stopped at S-08 in \d+\.\d s · \$0\.00 wasted$/, {
    timeout: 15_000,
  });
  await clearAndRedo(page, code);
  expect(await watch.end()).toEqual([]);
});

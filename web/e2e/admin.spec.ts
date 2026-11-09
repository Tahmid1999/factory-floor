import { expect, test } from '@playwright/test';
import { closeGuests, flash, guestPage, scanButton, stationLabel } from './helpers';

test.afterAll(closeGuests);

const OPS = ['cut', 'sew_collar', 'sew_sleeve', 'side_seam', 'hem', 'qc_final', 'pack', 'ship'];
const EMBEDDERS =
  'frame-ancestors https://tahmidalavi.netlify.app https://v2--tahmidalavi.netlify.app https://tahmidalavi.com http://localhost:3530';

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });

test('the floor lists all 8 ops with the gates marked', async ({ page }) => {
  await page.goto('/admin');
  for (const op of OPS) await expect(page.locator(`[data-row="${op}"]`)).toBeVisible();
  await expect(page.locator('[data-row]')).toHaveCount(8);
  await expect(page.locator('[data-row="cut"] [data-col="rate"]')).toHaveText('$0.010');
  for (const gate of ['cut', 'qc_final', 'ship']) {
    await expect(page.locator(`[data-row="${gate}"]`)).toHaveAttribute('data-gate', 'true');
  }
  await expect(page.locator('[data-row="hem"]')).not.toHaveAttribute('data-gate', 'true');
  await expect(page.getByTestId('sim-line')).toContainText('sim line off');
});

test('view as accounts hides Held, and a direct visit shows the 403 text', async ({ page }) => {
  await page.goto('/admin');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Held' })).toBeVisible();

  await page.getByLabel('view as').selectOption('accounts');
  await expect(page).toHaveURL(/as=accounts/);
  await expect(nav.getByRole('link', { name: 'Held' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Audit' })).toBeVisible();

  await page.goto('/admin/held?as=accounts');
  await expect(page.getByTestId('view-error')).toHaveText('accounts cannot see held');
});

test('slice 2 views are greyed, not links', async ({ page }) => {
  await page.goto('/admin');
  const nav = page.getByRole('navigation');
  for (const name of ['Payroll', 'Month P&L', 'Stock']) {
    await expect(nav.getByText(name)).toBeVisible();
    await expect(nav.getByRole('link', { name })).toHaveCount(0);
  }
  await expect(nav.getByText('slice 2')).toHaveCount(3);
});

test('a guest trap run shows in the bundle timeline with wasted', async ({ browser, page }) => {
  const guest = await guestPage(browser);
  await guest.getByRole('button', { name: 'all async' }).click();
  await expect(scanButton(guest)).toBeEnabled();
  await guest.getByRole('button', { name: 'Run the QC trap' }).click();
  await expect(guest.getByRole('button', { name: 'defect: collar' })).toBeEnabled({ timeout: 15_000 });
  await guest.getByRole('button', { name: 'defect: collar' }).click();
  await expect(flash(guest)).toContainText('queued locally');
  const sleeve = guest.getByRole('button', { name: /^scan B-\d+ at S-08$/ });
  await expect(sleeve).toBeEnabled();
  const code = /B-\d+/.exec((await sleeve.getAttribute('aria-label')) ?? (await sleeve.innerText()))?.[0];
  expect(code).toBeTruthy();
  await sleeve.click();
  await expect(stationLabel(guest)).toHaveText('S-08 · sew sleeve');
  await expect(guest.getByTestId('trap-result')).toContainText('$0.53 wasted', { timeout: 30_000 });

  await page.goto(`/admin/bundles/${code}`);
  const sew = page.locator('[data-row="sew_sleeve"]');
  await expect(sew.first()).toBeVisible();
  await expect(sew.filter({ hasText: 'wasted' })).toHaveCount(1);
  await expect(page.locator('[data-row="qc_flag"]').first()).toBeVisible();

  await page.goto('/admin/bundles');
  await page.getByPlaceholder('bundle code').fill(code!);
  await expect(page.locator(`[data-row="${code}"]`)).toBeVisible();
  await page.locator(`[data-row="${code}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/bundles/${code}`));
});

test('/hood shows a new batch line within 3 s of a scan', async ({ browser, page }) => {
  await page.goto('/hood');
  const batches = page.locator('[data-kind="batch"]');
  await expect(page.locator('[data-live="true"]')).toBeAttached();
  const before = await batches.count();

  const guest = await guestPage(browser);
  await expect(scanButton(guest)).toBeEnabled();
  await scanButton(guest).click();
  await expect(batches).toHaveCount(before + 1, { timeout: 3000 });
  await expect(batches.first()).toContainText(/batch dev-S07 seq \d+-\d+ · 1 in/);
});

test('rate and reset appear only when the session says admin', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('button', { name: 'Reset demo' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Admin login' })).toBeVisible();

  await page.route('**/admin/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'http://localhost:3140', 'access-control-allow-credentials': 'true' },
      body: JSON.stringify({ login: 'tahmid', role: 'admin' }),
    }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Reset demo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set rate' })).toBeVisible();
});

test('CSP: admin and hood allow the portfolio, everything else refuses framing', async ({ request }) => {
  for (const path of ['/admin', '/admin/bundles', '/hood']) {
    const res = await request.get(path);
    expect(res.headers()['content-security-policy'], path).toBe(EMBEDDERS);
  }
  const root = await request.get('/');
  expect(root.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
});

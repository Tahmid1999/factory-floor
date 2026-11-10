import { expect, test } from '@playwright/test';
import { closeGuests, flash, guestPage, scanButton, stationLabel } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const adminEnv = require('./admin-env.cjs') as { ADMIN_PASSWORD: string };

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

test('stock, payroll and month p&l are pages, and nothing says slice 2', async ({ page }) => {
  await page.goto('/admin');
  const nav = page.getByRole('navigation');
  for (const name of ['Payroll', 'Month P&L', 'Stock']) await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(nav.getByText('slice 2')).toHaveCount(0);

  await nav.getByRole('link', { name: 'Stock' }).click();
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await nav.getByRole('link', { name: 'Payroll' }).click();
  await expect(page.getByLabel('day')).toBeVisible();
  await nav.getByRole('link', { name: 'Month P&L' }).click();
  await expect(page.locator('[data-row="contribution"]')).toBeVisible();
});

test('the menu follows the role: storekeeper has Stock, accounts has Payroll and Month P&L', async ({ page }) => {
  const nav = page.getByRole('navigation');
  await page.goto('/admin/stock?as=storekeeper');
  await expect(nav.getByRole('link', { name: 'Stock' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Month P&L' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Payroll' })).toHaveCount(0);

  await page.goto('/admin/pnl?as=accounts');
  await expect(nav.getByRole('link', { name: 'Payroll' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Month P&L' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Stock' })).toHaveCount(0);

  await page.goto('/admin/stock?as=accounts');
  await expect(page.getByTestId('view-error')).toHaveText('accounts cannot see stock');
});

// The stress endpoint allows one run a minute per address, so this is the only
// test that presses the button.
test('the stress button: 10 taken, 10 refused, roll empty', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (/same key|unique "key"/.test(m.text())) warnings.push(m.text());
  });
  await page.goto('/admin/stock');
  await page.getByRole('button', { name: 'Try breaking it' }).click();
  await expect(page.getByTestId('stress-result')).toHaveText(
    /^20 issues at once on T-\d{4} · 10 taken · 10 refused · on hand 0\.0 m · \d+ ms$/,
  );
  // The receive and the 10 accepted issues, all with the same kind and delta.
  await expect(page.getByTestId('movements').locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(11);
  expect(warnings).toEqual([]);
});

test('p&l contribution is the sum of the lines shown', async ({ browser, page }) => {
  await closeGuests();
  const guest = await guestPage(browser);
  await expect(scanButton(guest)).toBeEnabled();
  await scanButton(guest).click();
  await expect(flash(guest)).toContainText(/sew_collar/);

  await page.goto('/admin/pnl');
  const mills = async (name: string) => Number(await page.locator(`[data-row="${name}"] [data-mills]`).getAttribute('data-mills'));
  // The scan's labour posting arrives through the worker, so wait for it.
  await expect.poll(() => mills('labour'), { timeout: 20_000 }).toBeLessThan(0);
  const lines = await page.locator('[data-line] [data-mills]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-mills'))));
  expect(lines.length).toBeGreaterThanOrEqual(5);
  expect(await mills('contribution')).toBe(lines.reduce((a, b) => a + b, 0));
  await expect(page.locator('[data-row="contribution"] [data-mills]')).toHaveText(/^-\$\d+\.\d\d$/);
  await closeGuests();
});

test('the close button needs a login, a past month and no close yet', async ({ page }) => {
  const cors = { 'access-control-allow-origin': 'http://localhost:3140', 'access-control-allow-credentials': 'true' };
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
  const pnl = (closed: unknown) => ({
    period: '2020-10', closed, revenue: 0, fabric: 0, trims: 0, labour: 0, adjustment: 0, late: [], contribution: 0, writeoff: 0,
    wip: { mills: 0, asOf: '2020-11-01T00:00:00.000Z' },
  });
  let closed: unknown = null;
  await page.route('**/admin/pnl/periods', (r) => r.fulfill(json([{ period: '2020-10', closed: closed !== null }])));
  await page.route('**/admin/pnl?**', (r) => r.fulfill(json(pnl(closed))));

  await page.goto('/admin/pnl');
  await expect(page.locator('[data-row="contribution"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Close / })).toHaveCount(0);

  await page.route('**/admin/session', (r) => r.fulfill(json({ login: 'tahmid', role: 'admin' })));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Close October' })).toBeVisible();

  closed = { period: '2020-10', closedAt: '2020-11-01T00:05:00.000Z', closedBy: 'seed' };
  await page.reload();
  await expect(page.getByTestId('closed-note')).toHaveText('closed 1 Nov 00:05 · by seed');
  await expect(page.getByRole('button', { name: /^Close / })).toHaveCount(0);
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

test('polling rides out server errors and recovers without navigation', async ({ page }) => {
  let failures = 0;
  await page.route('**/admin/floor**', (route) => {
    if (failures < 2) {
      failures++;
      return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"bad gateway"}' });
    }
    return route.continue();
  });
  await page.goto('/admin');
  await expect(page.getByText('offline · retrying')).toBeVisible();
  await expect(page.locator('[data-row]')).toHaveCount(8, { timeout: 20_000 });
  await expect(page.getByText('offline · retrying')).toHaveCount(0);
  expect(failures).toBe(2);
});

test('CSP: admin and hood allow the portfolio, everything else refuses framing', async ({ request }) => {
  for (const path of ['/admin', '/admin/bundles', '/hood']) {
    const res = await request.get(path);
    expect(res.headers()['content-security-policy'], path).toBe(EMBEDDERS);
  }
  const root = await request.get('/');
  expect(root.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
});

test('the owner logs in, sets a rate and resets the demo, both audited', async ({ page }) => {
  // Reset deletes guests, and an open station page would keep touching them.
  await closeGuests();
  await page.goto('/admin/login');
  await page.getByPlaceholder('login').fill('tahmid');
  await page.getByPlaceholder('password').fill(adminEnv.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('button', { name: 'Reset demo' })).toBeVisible();

  await page.locator('.adm-write .ant-select').click();
  await page.getByTitle('hem').click();
  await page.getByPlaceholder('mills / pc').fill('9');
  await page.getByRole('button', { name: 'Set rate' }).click();
  await expect(page.locator('.adm-write')).toContainText('hem 9 mills from');
  // It starts a minute ahead, so the table still shows the old rate.
  await expect(page.locator('[data-row="hem"] [data-col="rate"]')).toHaveText('$0.008');

  await page.getByRole('button', { name: 'Reset demo' }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(page.locator('.adm-write')).toContainText('reset done');

  await page.getByRole('link', { name: 'Audit' }).click();
  const rate = page.locator('.ant-table-tbody tr', { hasText: 'rate_change' });
  await expect(rate).toContainText('rate:hem');
  await expect(rate).toContainText('tahmid');
  await expect(page.locator('.ant-table-tbody tr', { hasText: 'guest and sim data' })).toContainText('reset');
});

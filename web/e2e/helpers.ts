import { Browser, BrowserContext, Page, devices } from '@playwright/test';

let nextIp = 10;
const open: BrowserContext[] = [];

// Each test is a new visitor from its own address: the API allows 5 new
// guests per address per hour, and trusts x-forwarded-for from loopback.
export async function guestPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    ...devices['Pixel 7'],
    baseURL: 'http://localhost:3140',
    extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${nextIp++}` },
  });
  open.push(ctx);
  const page = await ctx.newPage();
  await page.goto('/');
  return page;
}

// An open page keeps its heartbeat going, which would touch a guest the trap
// spec's database reset has already deleted.
export async function closeGuests() {
  await Promise.all(open.splice(0).map((c) => c.close()));
}

export const row = (page: Page, name: string) => page.locator(`[data-row="${name}"]`);
export const flash = (page: Page) => page.getByRole('status');
export const scanButton = (page: Page) => page.getByRole('button', { name: 'Scan next bundle' });
export const stationLabel = (page: Page) => page.getByTestId('station');

// Non-empty batches only; the 10 s heartbeat sends empty ones.
export function watchBatches(page: Page): { seqs: number[][] } {
  const seen = { seqs: [] as number[][] };
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !r.url().endsWith('/scans/batch')) return;
    const events = (JSON.parse(r.postData() ?? '{}').events ?? []) as { seq: number }[];
    if (events.length > 0) seen.seqs.push(events.map((e) => e.seq));
  });
  return seen;
}

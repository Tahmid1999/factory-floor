// Usage: node deploy/smoke.mjs https://factory.tahmidalavi.com https://factory-api.tahmidalavi.com
// One line per check; exit code 1 if any failed. Plain Node 22, no packages.
// Makes one guest, three devices, a handful of scans and one stress run, so it
// counts against the per-network limits (5 new guests an hour, one stress run
// a minute) like any visitor.
const [web, api] = process.argv.slice(2, 4).map((u) => (u ?? '').replace(/\/$/, ''));
if (![web, api].every((u) => /^https?:\/\//.test(u))) {
  console.error('usage: node smoke.mjs <web url> <api url>');
  process.exit(2);
}

let failed = 0;
async function check(name, run) {
  try {
    const detail = await run();
    console.log(`ok    ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(ms, probe) {
  const end = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found) return found;
    if (Date.now() > end) return undefined;
    await sleep(250);
  }
}

// Node's fetch keeps no cookies, so the guest cookie is the one jar entry.
let cookie = '';

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, json, text };
}

async function ok(path, init) {
  const out = await call(path, init);
  if (!out.res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} answered ${out.res.status}: ${out.text.slice(0, 120)}`);
  return out.json;
}

let me;
let collar; // device at S-07
let sleeve; // device at S-08
let qc; // device at Q-01
let code;
// scannedAt is checked against the server's clock; the offset from /me puts a
// laptop with a wrong clock right, as a station does.
let offsetMs = 0;

const scanBatch = (deviceId, events) =>
  ok('/scans/batch', {
    method: 'POST',
    body: { deviceId, deviceNow: Date.now(), events },
  });
const event = (seq, op) => ({ seq, bundleCode: code, op, scannedAt: Date.now(), offsetMs });

await check('/health reports postgres and rabbit ok', async () => {
  const body = await ok('/health');
  expect(body.postgres === 'ok' && body.rabbit === 'ok', JSON.stringify(body));
});

await check('/me makes a guest with 3 bundles', async () => {
  const before = Date.now();
  const { res, json } = await call('/me');
  expect(res.ok, `GET /me answered ${res.status}`);
  const set = res.headers.getSetCookie().find((c) => c.startsWith('ff_guest='));
  expect(set, 'no ff_guest cookie');
  cookie = set.split(';')[0];
  // Secure is set from NODE_ENV in the API, so a missing flag means the
  // container is not running in production mode.
  if (api.startsWith('https')) expect(/;\s*secure/i.test(set), 'cookie is not Secure');
  expect(json.bundles?.length === 3, `${json.bundles?.length} bundles`);
  expect(json.bundles.every((b) => b.nextOp === 'sew_collar' && b.status === 'active'), 'bundles are not all at sew_collar');
  me = json;
  code = json.bundles[0].code;
  offsetMs = json.serverNow - Math.round((before + Date.now()) / 2);
  return `${json.name}, ${json.bundles.map((b) => b.code).join(' ')}`;
});

await check('a batch round trip ends applied within 5 s', async () => {
  expect(me, 'needs the guest above');
  const make = async (station) => (await ok('/devices', { method: 'POST', body: { station } })).deviceId;
  collar = await make('S-07');
  sleeve = await make('S-08');
  qc = await make('Q-01');
  // A scan may not predate the device's registration.
  await sleep(300);
  const reply = await scanBatch(collar, [event(1, 'sew_collar')]);
  expect(reply.results[0]?.result === 'accepted', `first reply ${JSON.stringify(reply.results)}`);
  const start = Date.now();
  // The worker applies it; the bundle's next op moving on is the visible proof.
  const applied = await poll(5000, async () => {
    const now = await ok('/me');
    return now.bundles.find((b) => b.code === code)?.nextOp === 'sew_sleeve';
  });
  expect(applied, 'bundle did not reach sew_sleeve within 5 s, is the worker running?');
  return `${Date.now() - start} ms`;
});

await check('a gate flag and a rejected follow-up batch return resync', async () => {
  expect(collar && qc && sleeve, 'needs the devices above');
  const flag = await ok('/gate/scan', {
    method: 'POST',
    body: { deviceId: qc, gateId: crypto.randomUUID(), bundleCode: code, action: 'qc_flag', defect: 'collar' },
  });
  expect(flag.ok === true && flag.status === 'rework', `gate answered ${JSON.stringify(flag)}`);
  const reply = await scanBatch(sleeve, [event(1, 'sew_sleeve')]);
  expect(reply.results[0]?.result === 'rejected', `follow-up ${JSON.stringify(reply.results)}`);
  const entry = reply.resync.find((r) => r.bundleCode === code);
  expect(entry?.status === 'rework', `resync is ${JSON.stringify(reply.resync)}`);
});

await check('/events/recent is not empty', async () => {
  // Hood lines travel through RabbitMQ, so give the gate line a moment.
  const found = await poll(5000, async () => {
    const list = await ok('/events/recent');
    return Array.isArray(list) && list.length > 0 ? list : undefined;
  });
  expect(found, 'no events within 5 s');
  return `${found.length} lines`;
});

// The sim's work list answers the sim key from the worker's own address only.
// Through the proxy it must look like any unknown route, key or no key; set
// SIM_KEY in the environment to check that the real key is refused too.
await check('/sim/work answers 404 from outside', async () => {
  const headers = process.env.SIM_KEY ? { 'x-sim-key': process.env.SIM_KEY } : {};
  const res = await fetch(`${api}/sim/work?station=S-07`, { headers, signal: AbortSignal.timeout(10_000) });
  expect(res.status === 404, `answered ${res.status}`);
  return process.env.SIM_KEY ? 'with the sim key' : 'without a key';
});

// The seeded month: the reseed closes October on its way to now.
await check('/admin/pnl/periods lists 2026-10 as closed', async () => {
  const list = await ok('/admin/pnl/periods');
  const oct = Array.isArray(list) ? list.find((p) => p.period === '2026-10') : undefined;
  expect(oct, `no 2026-10 in ${JSON.stringify(list)}`);
  expect(oct.closed === true, '2026-10 is listed but not closed');
  return list.map((p) => `${p.period}${p.closed ? ' closed' : ''}`).join(', ');
});

// One run only: the button allows one a minute per address and 20 an hour in
// all, so a second smoke within a minute fails here and nowhere else.
await check('a stress run ends with its test roll at 0 cm', async () => {
  const { res, json, text } = await call('/admin/stock/stress', { method: 'POST' });
  expect(res.status !== 429, `refused with 429 (${json?.error ?? text.slice(0, 80)}); wait a minute and run the smoke again`);
  expect(res.ok, `POST /admin/stock/stress answered ${res.status}: ${text.slice(0, 120)}`);
  expect(json.onHandCm === 0, `roll ${json.roll} has ${json.onHandCm} cm left`);
  return `${json.roll}, ${json.accepted} taken, ${json.refused} refused, ${json.ms} ms`;
});

await check("/admin/payroll for today has the sim's workers", async () => {
  const body = await ok('/admin/payroll');
  const sims = (body.rows ?? []).filter((r) => r.kind === 'sim');
  expect(sims.length > 0, `no sim rows for ${body.day} in ${body.rows?.length ?? 0}`);
  return `${body.day}, ${sims.length} sim of ${body.rows.length}`;
});

// The station pages are served by Vercel with their own frame policy: the
// admin may be embedded by the portfolio, everything else may not.
async function page(path) {
  const res = await fetch(`${web}${path}`, { signal: AbortSignal.timeout(15_000) });
  expect(res.status === 200, `${path} answered ${res.status}`);
  return res.headers.get('content-security-policy') ?? '';
}

await check('the web / answers 200 and cannot be framed', async () => {
  const csp = await page('/');
  expect(csp.includes("frame-ancestors 'none'"), `csp is "${csp}"`);
});

await check('the web /admin answers 200 and may be framed by the portfolio', async () => {
  const csp = await page('/admin');
  expect(/frame-ancestors [^;]*https:\/\/tahmidalavi\.com/.test(csp), `csp is "${csp}"`);
  expect(!csp.includes("'none'"), `csp is "${csp}"`);
});

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

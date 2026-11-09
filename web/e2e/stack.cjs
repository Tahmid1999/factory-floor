// The API and the worker for Playwright: built fresh, pointed at factory_test,
// with the simulated line off so nothing but the test touches a bundle. The
// sim-on config sets STACK_SIM=1 to run the trap beside a live line instead.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const api = path.join(root, 'api');
const env = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  SIM_ENABLED: process.env.STACK_SIM === '1' ? '1' : '0',
  WEB_ORIGIN: 'http://localhost:3140',
  PORT: '4120',
  ...require('./admin-env.cjs'),
};

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('npm', ['run', 'build'], api);
run('npm', ['run', 'migrate:test'], api);
run('node', [path.join(__dirname, 'reset-db.cjs')], root);

const kids = ['dist/main.js', 'dist/worker.js'].map((f) => spawn('node', [f], { cwd: api, env, stdio: 'inherit' }));
const stop = () => {
  for (const k of kids) k.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const k of kids) k.on('exit', (code) => code && process.exit(code));

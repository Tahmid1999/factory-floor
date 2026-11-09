// Migrations must run as ff_owner; the app's own DATABASE_URL belongs to ff_app.
const { spawnSync } = require('node:child_process');

const url = process.argv[2] === 'test' ? process.env.TEST_OWNER_DATABASE_URL : process.env.OWNER_DATABASE_URL;
if (!url) {
  console.error('owner database url is not set');
  process.exit(1);
}
const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});
process.exit(r.status ?? 1);

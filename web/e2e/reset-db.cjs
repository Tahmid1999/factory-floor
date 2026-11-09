// Wipes factory_test and seeds the line, as the API's own test helper does,
// so the first guest of a run gets B-8492. It runs as ff_owner because ff_app
// may not truncate the audit log.
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const api = path.join(root, 'api');
const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [api] }));
const { seedLine } = require(path.join(api, 'dist/seed.js'));

async function main() {
  const owner = new PrismaClient({ datasources: { db: { url: process.env.TEST_OWNER_DATABASE_URL } } });
  const app = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  try {
    const tables = await owner.$queryRaw`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    await owner.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
    await owner.$executeRawUnsafe('ALTER SEQUENCE bundle_code_seq RESTART WITH 8492');
    await seedLine(app);
  } finally {
    await owner.$disconnect();
    await app.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

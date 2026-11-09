import { PrismaClient } from '@prisma/client';
import { resetDb } from './helpers';

// Runs as ff_app, the same role the API uses.
describe('audit log grants', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
    } catch (e: any) {
      return e.meta?.code ?? e.code;
    }
    return undefined;
  }

  it('lets the app role insert', async () => {
    const row = await prisma.auditLog.create({
      data: { actor: 'admin', role: 'admin', action: 'test', entity: 'bundle:1' },
    });
    expect(row.id).toBeTruthy();
  });

  it('refuses update with 42501', async () => {
    const code = await pgCode(() => prisma.$executeRaw`UPDATE "AuditLog" SET actor = 'x'`);
    expect(code).toBe('42501');
  });

  it('refuses delete with 42501', async () => {
    const code = await pgCode(() => prisma.$executeRaw`DELETE FROM "AuditLog"`);
    expect(code).toBe('42501');
  });
});

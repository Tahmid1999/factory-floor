import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import {
  FOB_MILLS,
  OPERATIONS,
  PIECES_PER_BUNDLE,
  POLO_ROUTE,
  RATES_EFFECTIVE_FROM,
  RATES_MILLS,
  STYLE_CODE,
  STYLE_NAME,
} from './line/line';
import { receive } from './stock/stock';

const OPENING_ROLLS = 6;
const OPENING_COST_MILLS = 3400;

export async function seedLine(prisma: PrismaClient, now: Date = new Date()): Promise<void> {
  const style = await prisma.style.upsert({
    where: { code: STYLE_CODE },
    update: { name: STYLE_NAME, piecesPerBundle: PIECES_PER_BUNDLE, fobMills: FOB_MILLS, route: POLO_ROUTE },
    create: { code: STYLE_CODE, name: STYLE_NAME, piecesPerBundle: PIECES_PER_BUNDLE, fobMills: FOB_MILLS, route: POLO_ROUTE },
  });

  for (const op of OPERATIONS) {
    await prisma.operation.upsert({
      where: { code: op.code },
      update: { isGate: op.isGate, trimsMills: op.trimsMills },
      create: op,
    });
  }

  // PieceRate has no natural unique key, so look the row up before writing.
  for (const [op, ratePerPieceMills] of Object.entries(RATES_MILLS)) {
    const where = { styleId: style.id, op, effectiveFrom: RATES_EFFECTIVE_FROM };
    const existing = await prisma.pieceRate.findFirst({ where });
    if (existing) {
      await prisma.pieceRate.update({ where: { id: existing.id }, data: { ratePerPieceMills } });
    } else {
      await prisma.pieceRate.create({ data: { ...where, ratePerPieceMills } });
    }
  }

  // Opening stock goes in only on a ledger with no real roll in it, so running
  // the seed again adds no fabric.
  if (!(await prisma.roll.findFirst({ where: { isTest: false } }))) {
    await prisma.$transaction((tx) =>
      receive(tx, now, { count: OPENING_ROLLS, costPerMetreMills: OPENING_COST_MILLS, actor: 'seed', isSimulated: true }),
    );
  }

  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    const passwordHash = await hash(password, 10);
    await prisma.user.upsert({
      where: { login: 'tahmid' },
      update: { passwordHash, role: 'admin' },
      create: { login: 'tahmid', passwordHash, role: 'admin' },
    });
  }
}

import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';
import {
  OPERATIONS,
  PIECES_PER_BUNDLE,
  POLO_ROUTE,
  RATES_EFFECTIVE_FROM,
  RATES_MILLS,
  STYLE_CODE,
  STYLE_NAME,
} from './line/line';

export async function seedLine(prisma: PrismaClient): Promise<void> {
  const style = await prisma.style.upsert({
    where: { code: STYLE_CODE },
    update: { name: STYLE_NAME, piecesPerBundle: PIECES_PER_BUNDLE, route: POLO_ROUTE },
    create: { code: STYLE_CODE, name: STYLE_NAME, piecesPerBundle: PIECES_PER_BUNDLE, route: POLO_ROUTE },
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

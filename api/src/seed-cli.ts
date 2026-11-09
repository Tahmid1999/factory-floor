import { config } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { seedLine } from './seed';

config({ path: resolve(__dirname, '../../.env') });

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedLine(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main();

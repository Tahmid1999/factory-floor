import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';
import { PrismaService } from './prisma.service';

// One Prisma client and one clock for every feature module in the API, so a
// test that overrides CLOCK moves time everywhere at once.
@Global()
@Module({
  providers: [PrismaService, { provide: CLOCK, useClass: SystemClock }],
  exports: [PrismaService, CLOCK],
})
export class CoreModule {}

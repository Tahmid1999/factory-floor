import { Global, Module } from '@nestjs/common';
import { CLOCK, processClock } from './clock';
import { PrismaService } from './prisma.service';
import { Rabbit } from './rabbit';

// One Prisma client, one broker connection and one clock for every feature
// module in the API, so a test that overrides CLOCK moves time everywhere at once.
@Global()
@Module({
  providers: [PrismaService, Rabbit, { provide: CLOCK, useFactory: processClock }],
  exports: [PrismaService, Rabbit, CLOCK],
})
export class CoreModule {}

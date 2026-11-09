import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CLOCK, SystemClock } from './clock';
import { PrismaService } from './prisma.service';
import { Rabbit } from './rabbit';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] })],
  providers: [PrismaService, Rabbit, { provide: CLOCK, useClass: SystemClock }],
})
export class WorkerModule {}

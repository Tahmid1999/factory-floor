import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CLOCK, SystemClock } from './clock';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma.service';
import { Rabbit } from './rabbit';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }), ScheduleModule.forRoot()],
  controllers: [HealthController],
  providers: [PrismaService, Rabbit, { provide: CLOCK, useClass: SystemClock }],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ApplyModule } from './apply/apply.module';
import { CoreModule } from './core.module';
import { PurgeModule } from './purge/purge.module';
import { SimModule } from './sim/sim.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    ScheduleModule.forRoot(),
    CoreModule,
    ApplyModule,
    PurgeModule,
    SimModule,
  ],
})
export class WorkerModule {}

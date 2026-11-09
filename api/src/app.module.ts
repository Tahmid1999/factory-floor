import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CoreModule } from './core.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { GateModule } from './gate/gate.module';
import { GuestsModule } from './guests/guests.module';
import { HealthController } from './health.controller';
import { HoodModule } from './hood/hood.module';
import { IngestModule } from './ingest/ingest.module';
import { SimWorkController } from './sim/sim-work.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    ScheduleModule.forRoot(),
    CoreModule,
    GuestsModule,
    AuthModule,
    IngestModule,
    GateModule,
    HoodModule,
    AdminModule,
  ],
  controllers: [HealthController, SimWorkController],
})
export class AppModule {}

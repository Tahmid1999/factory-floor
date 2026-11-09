import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CoreModule } from './core.module';
import { AuthModule } from './auth/auth.module';
import { GateModule } from './gate/gate.module';
import { GuestsModule } from './guests/guests.module';
import { HealthController } from './health.controller';
import { IngestModule } from './ingest/ingest.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    ScheduleModule.forRoot(),
    CoreModule,
    GuestsModule,
    AuthModule,
    IngestModule,
    GateModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

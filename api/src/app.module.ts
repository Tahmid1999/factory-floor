import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { CoreModule } from './core.module';
import { GuestsModule } from './guests/guests.module';
import { HealthController } from './health.controller';
import { Rabbit } from './rabbit';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../.env', '.env'] }),
    ScheduleModule.forRoot(),
    CoreModule,
    GuestsModule,
  ],
  controllers: [HealthController],
  providers: [Rabbit],
})
export class AppModule {}

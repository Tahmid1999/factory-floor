import { Module } from '@nestjs/common';
import { GuestsModule } from '../guests/guests.module';
import { HoodModule } from '../hood/hood.module';
import { IngestModule } from '../ingest/ingest.module';
import { GateController } from './gate.controller';
import { GateService } from './gate.service';

// API only: gate calls are answered here and never go through the queue.
@Module({
  imports: [GuestsModule, IngestModule, HoodModule],
  controllers: [GateController],
  providers: [GateService],
})
export class GateModule {}
